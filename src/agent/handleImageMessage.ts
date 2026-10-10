import { supabase } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { descargarMedia } from "../whatsapp/client.js";
import { sendTextIfWindowOpen } from "../whatsapp/window.js";
import { subirAdjunto } from "../lib/adjuntos.js";
import { guardarMensaje, marcarExternalId } from "../db/repositories/mensajes.js";
import { escalarConversacion } from "../db/repositories/conversaciones.js";
import { getCitaPendienteDeComprobante, guardarComprobante } from "../db/repositories/citas.js";
import { analizarComprobante } from "./paymentProof.js";
import type { InboundMessage } from "../whatsapp/parser.js";
import type { Cliente } from "../db/repositories/clientes.js";
import type { Conversacion } from "../db/repositories/conversaciones.js";

const EXTENSION_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const SIN_CITA_PENDIENTE =
  "Gracias por la imagen 🙏 Ahorita no tengo ninguna cita tuya esperando comprobante de pago. " +
  "Si es sobre otra cosa, cuéntame por texto en qué te ayudo.";

function textoConfirmado(montoDetectado: number | null): string {
  const monto = montoDetectado != null ? ` de S/ ${montoDetectado}` : "";
  return `¡Recibido! Confirmé tu comprobante${monto} y tu cita ya quedó pagada ✅ Nos vemos pronto 💕`;
}

const TEXTO_EN_REVISION =
  "Recibí tu comprobante 🙏 No pude confirmarlo automáticamente, así que lo va a revisar una asesora de Aura Studio " +
  "en breve. Te avisamos apenas quede confirmado.";

type MensajeImagen = Extract<InboundMessage, { kind: "image" }>;

/** Los bytes de la foto ya bajada de WhatsApp (null si la descarga falló), para no bajarla dos veces. */
export type ImagenDescargada = { buffer: Buffer; mimeType: string } | null;

/**
 * Deja la foto en el chat para que el panel la muestre: se baja de WhatsApp
 * (el media id caduca, hay que hacerlo al recibirla), se sube al bucket
 * privado `adjuntos` y el mensaje queda con `media_path`. Corre SIEMPRE,
 * también con la conversación escalada: antes la foto de una conversación
 * escalada no se guardaba y el staff nunca la veía. Si la descarga falla, el
 * mensaje se guarda igual con el error, para que el staff sepa que llegó
 * algo y lo pida de nuevo (mismo criterio que documentoEntrante.ts de B&B).
 */
export async function guardarImagenEntrante(message: MensajeImagen, conversacion: Conversacion): Promise<ImagenDescargada> {
  let descargada: ImagenDescargada = null;
  let mediaPath: string | undefined;
  let errorDescarga: string | undefined;
  try {
    descargada = await descargarMedia(message.mediaId);
    mediaPath = await subirAdjunto({
      conversacionId: conversacion.id,
      buffer: descargada.buffer,
      mimeType: descargada.mimeType,
    });
  } catch (err) {
    errorDescarga = err instanceof Error ? err.message : String(err);
    logger.error({ err, conversacionId: conversacion.id, waMessageId: message.id }, "No se pudo descargar/guardar la imagen entrante");
  }

  await guardarMensaje({
    conversacionId: conversacion.id,
    rol: "user",
    contenido: message.caption ? `[Imagen recibida] ${message.caption}` : "[Imagen recibida]",
    waMessageId: message.id,
    mediaType: "image",
    ...(mediaPath ? { mediaPath } : {}),
    metadata: {
      mime_type: descargada?.mimeType ?? message.mimeType,
      ...(message.caption ? { caption: message.caption } : {}),
      ...(errorDescarga ? { error_descarga: errorDescarga.slice(0, 300) } : {}),
    },
  });

  return descargada;
}

/**
 * Flujo separado del loop conversacional normal (como el de audio): una
 * imagen no es un mensaje de texto que Claude deba interpretar con tools,
 * es un comprobante que se analiza una sola vez y de forma determinística.
 * Nunca decide "en silencio" — o confirma con evidencia clara, o deja el
 * caso visible para un humano (en_revision + conversación escalada).
 * La foto ya quedó guardada en el chat por `guardarImagenEntrante`.
 */
export async function handleImageMessage(
  message: MensajeImagen,
  cliente: Cliente,
  conversacion: Conversacion,
  imagen: ImagenDescargada,
): Promise<void> {
  const pendiente = await getCitaPendienteDeComprobante(cliente.id);
  if (!pendiente) {
    const guardado = await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: SIN_CITA_PENDIENTE });
    const waMessageId = await sendTextIfWindowOpen(message.from, SIN_CITA_PENDIENTE);
    if (waMessageId) await marcarExternalId(guardado.id, waMessageId).catch(() => {});
    return;
  }

  const { cita, depositoEsperado } = pendiente;

  let respuesta: string;
  try {
    if (!imagen) throw new Error("La imagen no se pudo descargar de WhatsApp");
    const { buffer, mimeType } = imagen;
    const extension = EXTENSION_POR_MIME[mimeType] ?? "jpg";
    const path = `${cita.id}/${Date.now()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("comprobantes")
      .upload(path, buffer, { contentType: mimeType });
    if (uploadError) throw uploadError;

    const analisis = await analizarComprobante({
      imagenBase64: buffer.toString("base64"),
      mimeType,
      montoEsperado: depositoEsperado,
    });

    if (analisis.pareceComprobanteValido) {
      await guardarComprobante(cita.id, {
        estado: "confirmado",
        path,
        montoDetectado: analisis.montoDetectado,
        nota: analisis.razon,
      });
      respuesta = textoConfirmado(analisis.montoDetectado);
      logger.info({ citaId: cita.id, monto: analisis.montoDetectado }, "Comprobante de pago confirmado automáticamente");
    } else {
      await guardarComprobante(cita.id, {
        estado: "en_revision",
        path,
        montoDetectado: analisis.montoDetectado,
        nota: analisis.razon,
      });
      await escalarConversacion(conversacion.id);
      respuesta = TEXTO_EN_REVISION;
      logger.warn({ citaId: cita.id, razon: analisis.razon }, "Comprobante de pago no se pudo confirmar automáticamente");
    }
  } catch (err) {
    logger.error({ err, citaId: cita.id }, "Falló el procesamiento del comprobante de pago");
    await escalarConversacion(conversacion.id).catch(() => {});
    respuesta = TEXTO_EN_REVISION;
  }

  const guardado = await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: respuesta });
  const waMessageId = await sendTextIfWindowOpen(message.from, respuesta);
  if (waMessageId) await marcarExternalId(guardado.id, waMessageId).catch(() => {});
}
