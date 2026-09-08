import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { isRateLimited } from "../lib/rateLimit.js";
import { findOrCreateByPhone } from "../db/repositories/clientes.js";
import { getOrCreateConversacionAbierta } from "../db/repositories/conversaciones.js";
import { guardarMensaje, marcarExternalId } from "../db/repositories/mensajes.js";
import { sendTextIfWindowOpen } from "../whatsapp/window.js";
import { handleInbound } from "./handleInbound.js";
import { handleImageMessage } from "./handleImageMessage.js";
import type { InboundMessage } from "../whatsapp/parser.js";

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

export async function handleInboundMessage(message: InboundMessage): Promise<void> {
  if (isRateLimited(message.from, env.RATE_LIMIT_MAX_PER_MINUTE)) {
    // Se descarta sin responder: una respuesta (aunque sea de rechazo)
    // premia el abuso con engagement y gasta una llamada a la Graph API.
    logger.warn({ from: message.from }, "Mensaje descartado por rate limit");
    return;
  }

  const cliente = await findOrCreateByPhone(message.from, message.contactName);
  const conversacion = await getOrCreateConversacionAbierta({ clienteId: cliente.id, canal: "whatsapp" });

  if (message.kind === "audio") {
    if (conversacion.estado === "escalada") {
      // Un humano ya está atendiendo: no le mandamos el mensaje fijo por
      // encima de lo que esa persona esté por escribir.
      logger.info({ conversacionId: conversacion.id }, "Conversación escalada, se ignora el audio");
      return;
    }
    const texto = "Por ahora no puedo escuchar audios 🙏 ¿me lo escribes en un mensaje de texto?";
    const guardado = await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: texto });
    const waMessageId = await sendTextIfWindowOpen(message.from, texto);
    if (waMessageId) await marcarExternalId(guardado.id, waMessageId).catch(() => {});
    return;
  }

  if (message.kind === "image") {
    if (conversacion.estado === "escalada") {
      // Mismo criterio: si ya hay una persona atendiendo, el flujo
      // automático de comprobantes de pago no debe correr por encima.
      logger.info({ conversacionId: conversacion.id }, "Conversación escalada, se ignora la imagen");
      return;
    }
    await handleImageMessage(message, cliente, conversacion);
    return;
  }

  const userText = extractText(message);
  if (userText === null) {
    logger.info({ kind: message.kind }, "Tipo de mensaje sin manejo de texto, se ignora");
    return;
  }

  // handleInbound guarda el mensaje ANTES de mirar si la conversación está
  // escalada — a propósito: antes, una conversación escalada ni siquiera
  // guardaba el mensaje de texto entrante (se descartaba en el primer
  // `return` de esta función, antes de llegar acá), así que el staff nunca
  // veía en el panel lo último que la clienta había escrito.
  await handleInbound({
    conversacion,
    canal: "whatsapp",
    destinatarioId: message.from,
    // El wa_id del remitente ES el teléfono, así que en WhatsApp nunca falta
    // aunque la columna ya admita null para los leads de otros canales.
    telefono: cliente.telefono ?? message.from,
    contactName: message.contactName,
    texto: userText,
    externalId: message.id,
  });
}
