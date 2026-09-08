import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { isRateLimited } from "../lib/rateLimit.js";
import { resolverIdentidad } from "../meta/identidades.js";
import { getOrCreateConversacionAbierta } from "../db/repositories/conversaciones.js";
import { guardarMensaje, existeExternalId } from "../db/repositories/mensajes.js";
import { descargarAdjunto } from "../meta/client.js";
import { subirAdjunto, mediaTypeDeAttachment } from "../lib/adjuntos.js";
import { handleInbound } from "./handleInbound.js";
import { handleComentario } from "./handleComentario.js";
import type { CanalMeta, EventoMeta } from "../meta/parser.js";

const TIPO_IDENTIDAD_MENSAJERIA: Record<CanalMeta, "psid" | "igsid"> = { messenger: "psid", instagram: "igsid" };

/**
 * Punto de entrada único para cualquier evento que salió de
 * meta/parser.ts — DMs, comentarios, ecos, lo que sea. metaWebhook.ts llama
 * a esto por cada evento del payload, ya con el dedupe de external_id hecho.
 */
export async function handleInboundMeta(evento: EventoMeta): Promise<void> {
  if (evento.kind === "no_soportado") {
    logger.info({ canal: evento.canal, motivo: evento.motivo, externalId: evento.externalId }, "Evento de Meta no soportado, se ignora");
    return;
  }

  if (evento.kind === "comentario_nuevo" || evento.kind === "comentario_eliminado") {
    await handleComentario(evento);
    return;
  }

  // A partir de acá: dm_texto | dm_adjunto | dm_eco | dm_postback — todos
  // tienen remitenteId como string (a diferencia de los comentarios, que
  // pueden no traer `from`).
  if (isRateLimited(`${evento.canal}:${evento.remitenteId}`, env.RATE_LIMIT_MAX_PER_MINUTE)) {
    logger.warn({ canal: evento.canal, remitenteId: evento.remitenteId }, "Mensaje descartado por rate limit");
    return;
  }

  const { cliente, identidad } = await resolverIdentidad({
    canal: evento.canal,
    tipo: TIPO_IDENTIDAD_MENSAJERIA[evento.canal],
    externalId: evento.remitenteId,
    cuentaId: evento.cuentaId,
  });

  const conversacion = await getOrCreateConversacionAbierta({
    clienteId: cliente.id,
    canal: evento.canal,
    origen: "dm",
    identidadId: identidad.id,
    cuentaId: evento.cuentaId,
  });

  if (evento.kind === "dm_eco") {
    // Si ya existe, es nuestro propio envío (se guardó al mandarlo, con este
    // mismo external_id) — no hay nada que hacer. Si no existe, alguien
    // respondió desde Meta Business Suite, fuera del panel: se guarda como
    // 'humano' sin autor, para que quede visible igual.
    if (await existeExternalId(evento.externalId)) return;
    if (evento.texto) {
      await guardarMensaje({
        conversacionId: conversacion.id,
        rol: "humano",
        contenido: evento.texto,
        externalId: evento.externalId,
        metadata: { via: "business_suite" },
      });
    }
    return;
  }

  if (evento.kind === "dm_postback") {
    await handleInbound({
      conversacion,
      canal: evento.canal,
      destinatarioId: evento.remitenteId,
      telefono: cliente.telefono,
      contactName: identidad.nombre_perfil ?? undefined,
      texto: evento.titulo ?? evento.payload,
      externalId: evento.externalId,
    });
    return;
  }

  if (evento.kind === "dm_adjunto") {
    // Se guarda; el agente no lo interpreta todavía (fuera del alcance de
    // esta fase — ver PROMPT-OMNICANAL.md §3.10).
    try {
      const { buffer, mimeType } = await descargarAdjunto(evento.url);
      const mediaPath = await subirAdjunto({ conversacionId: conversacion.id, buffer, mimeType });
      await guardarMensaje({
        conversacionId: conversacion.id,
        rol: "user",
        contenido: `[${evento.attachmentType}]`,
        externalId: evento.externalId,
        mediaPath,
        mediaType: mediaTypeDeAttachment(evento.attachmentType),
        metadata: { attachment_type: evento.attachmentType },
      });
    } catch (err) {
      logger.error({ err, canal: evento.canal, externalId: evento.externalId }, "No se pudo descargar/guardar un adjunto de Meta");
    }
    return;
  }

  // dm_texto
  await handleInbound({
    conversacion,
    canal: evento.canal,
    destinatarioId: evento.remitenteId,
    telefono: cliente.telefono,
    contactName: identidad.nombre_perfil ?? undefined,
    texto: evento.texto,
    externalId: evento.externalId,
  });
}
