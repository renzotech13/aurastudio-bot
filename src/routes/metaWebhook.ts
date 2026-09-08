import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { metaAppSecret, metaVerifyToken } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { verifyMetaSignature } from "../lib/metaSignature.js";
import { parseEventosMeta, describeParsePayloadError } from "../meta/parser.js";
import { handleInboundMeta } from "../agent/handleInboundMeta.js";
import { existeExternalId } from "../db/repositories/mensajes.js";
import { actualizarEstadoCanal } from "../db/repositories/canales.js";

/**
 * Un evento repetido de Meta no debe reprocesarse: para un dm_texto o
 * dm_postback significaría correr el agente dos veces y mandar dos
 * respuestas. Los comentario_eliminado y no_soportado no necesitan este
 * filtro — el primero solo marca metadata (repetirlo es inofensivo) y el
 * segundo no hace nada de todos modos.
 */
async function esEventoDuplicado(evento: { kind: string; externalId: string }): Promise<boolean> {
  if (evento.kind === "comentario_eliminado" || evento.kind === "no_soportado") return false;
  return existeExternalId(evento.externalId).catch(() => false);
}

async function processMetaWebhookAsync(body: unknown): Promise<void> {
  const parseError = describeParsePayloadError(body);
  if (parseError) {
    // Igual que webhook.ts de WhatsApp: un payload que no calza queda
    // registrado en vez de desaparecer en silencio absoluto.
    logger.warn({ parseError, body }, "Payload de webhook de Meta no calzó con el esquema esperado, se ignora");
    return;
  }

  const objeto = (body as { object?: string }).object;
  const canal = objeto === "instagram" ? "instagram" : "messenger";
  actualizarEstadoCanal(canal, { ultimoWebhookAt: new Date() }).catch((err: unknown) =>
    logger.warn({ err, canal }, "No se pudo actualizar la salud del canal"),
  );

  const eventos = parseEventosMeta(body);
  for (const evento of eventos) {
    if (await esEventoDuplicado(evento)) {
      logger.info({ externalId: evento.externalId, canal: evento.canal, kind: evento.kind }, "Evento de Meta duplicado, se ignora");
      continue;
    }
    try {
      await handleInboundMeta(evento);
    } catch (err) {
      logger.error({ err, kind: evento.kind, canal: evento.canal }, "Fallo manejando un evento de Meta");
    }
  }
}

export async function metaWebhookRoutes(app: FastifyInstance) {
  app.get("/webhook/meta", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode === "subscribe" && token === metaVerifyToken && challenge) {
      logger.info("Verificación de webhook de Meta (Messenger/Instagram) exitosa");
      return reply.status(200).send(challenge);
    }

    logger.warn({ mode }, "Verificación de webhook de Meta rechazada: token o modo inválido");
    return reply.status(403).send("Forbidden");
  });

  app.post("/webhook/meta", async (request: FastifyRequest, reply: FastifyReply) => {
    const signature = request.headers["x-hub-signature-256"] as string | undefined;

    if (!verifyMetaSignature(request.rawBody, signature, metaAppSecret)) {
      logger.warn("Firma de webhook de Meta inválida o ausente");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    // Responder 200 de inmediato; Meta reintenta si tardamos. Mismo patrón
    // que el webhook de WhatsApp.
    reply.status(200).send({ received: true });

    processMetaWebhookAsync(request.body).catch((err: unknown) => {
      logger.error({ err }, "Error procesando webhook de Meta de forma asíncrona");
    });
  });
}
