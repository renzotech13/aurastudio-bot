import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { isRateLimited } from "../lib/rateLimit.js";
import { findOrCreateByPhone } from "../db/repositories/clientes.js";
import { getOrCreateConversacionAbierta, escalarConversacion } from "../db/repositories/conversaciones.js";
import { guardarMensaje, marcarWaMessageId } from "../db/repositories/mensajes.js";
import { sendTextIfWindowOpen } from "../whatsapp/window.js";
import { runAgent, FALLBACK_MESSAGE } from "./runner.js";
import { handleImageMessage } from "./handleImageMessage.js";
import type { InboundMessage } from "../whatsapp/parser.js";

const AGENT_TIMEOUT_MS = 25_000;

function extractText(message: InboundMessage): string | null {
  switch (message.kind) {
    case "text":
      return message.text;
    case "interactive_reply":
      return message.replyTitle;
    case "audio":
      return null; // se maneja aparte: mensaje fijo, no pasa por el agente.
    default:
      return null;
  }
}

async function runAgentWithTimeout(
  ctx: Parameters<typeof runAgent>[0],
  userText: string,
): Promise<string> {
  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<string>((resolve) => {
    timeoutId = setTimeout(() => resolve(FALLBACK_MESSAGE), AGENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([runAgent(ctx, userText), timeout]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export async function handleInboundMessage(message: InboundMessage): Promise<void> {
  if (isRateLimited(message.from, env.RATE_LIMIT_MAX_PER_MINUTE)) {
    // Se descarta sin responder: una respuesta (aunque sea de rechazo)
    // premia el abuso con engagement y gasta una llamada a la Graph API.
    logger.warn({ from: message.from }, "Mensaje descartado por rate limit");
    return;
  }

  const cliente = await findOrCreateByPhone(message.from, message.contactName);
  const conversacion = await getOrCreateConversacionAbierta({ clienteId: cliente.id, canal: "whatsapp" });

  if (conversacion.estado === "escalada") {
    // Un humano ya está atendiendo esta conversación; no interviene el bot.
    logger.info({ conversacionId: conversacion.id }, "Conversación escalada, se ignora el mensaje del bot");
    return;
  }

  if (message.kind === "audio") {
    const texto = "Por ahora no puedo escuchar audios 🙏 ¿me lo escribes en un mensaje de texto?";
    const guardado = await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: texto });
    const waMessageId = await sendTextIfWindowOpen(message.from, texto);
    if (waMessageId) await marcarWaMessageId(guardado.id, waMessageId).catch(() => {});
    return;
  }

  if (message.kind === "image") {
    await handleImageMessage(message, cliente, conversacion);
    return;
  }

  const userText = extractText(message);
  if (userText === null) {
    logger.info({ kind: message.kind }, "Tipo de mensaje sin manejo de texto, se ignora");
    return;
  }

  // `ultimo_mensaje_at` lo mueve el trigger mensajes_actualiza_conversacion
  // (migración 0017), no un UPDATE aparte: así el mensaje y la conversación
  // avanzan en la misma transacción y vale igual para lo que escriba el panel.
  await guardarMensaje({
    conversacionId: conversacion.id,
    rol: "user",
    contenido: userText,
    waMessageId: message.id,
  });

  let respuesta: string;
  try {
    respuesta = await runAgentWithTimeout(
      // El wa_id del remitente ES el teléfono, así que en WhatsApp nunca falta
      // aunque la columna ya admita null para los leads de otros canales.
      { telefono: cliente.telefono ?? message.from, conversacionId: conversacion.id, contactName: message.contactName },
      userText,
    );
  } catch (err) {
    logger.error({ err }, "Fallo inesperado orquestando el agente");
    respuesta = FALLBACK_MESSAGE;
    await escalarConversacion(conversacion.id).catch(() => {});
  }

  const guardado = await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: respuesta });
  const waMessageId = await sendTextIfWindowOpen(message.from, respuesta);
  if (waMessageId) await marcarWaMessageId(guardado.id, waMessageId).catch(() => {});
}
