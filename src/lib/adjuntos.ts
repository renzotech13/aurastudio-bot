import { supabase } from "../db/client.js";
import type { AttachmentType } from "../meta/parser.js";
import type { TipoMediaMensaje } from "../db/repositories/mensajes.js";

const EXTENSION_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
};

/** No hay una categoría exacta de mensajes.media_type para todo lo que manda Meta: se aproxima con la más cercana. */
const MEDIA_TYPE_POR_ATTACHMENT: Record<AttachmentType, TipoMediaMensaje> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
  share: "document",
  story_mention: "document",
  ig_reel: "video",
  otro: "document",
};

export function mediaTypeDeAttachment(tipo: AttachmentType): TipoMediaMensaje {
  return MEDIA_TYPE_POR_ATTACHMENT[tipo];
}

/**
 * Sube un adjunto entrante de Messenger/Instagram al bucket privado
 * `adjuntos` — a diferencia de `comprobantes` (también privado, pero
 * exclusivo del flujo de pago de WhatsApp) o `plantillas-media` (público,
 * biblioteca que el negocio elige mandar), esto es contenido que la clienta
 * mandó y que el panel muestra con URL firmada (mismo patrón que
 * `comprobantes` en ClientPanel.tsx).
 */
export async function subirAdjunto(params: {
  conversacionId: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<string> {
  const extension = EXTENSION_POR_MIME[params.mimeType] ?? "bin";
  const path = `${params.conversacionId}/${Date.now()}.${extension}`;

  const { error } = await supabase.storage.from("adjuntos").upload(path, params.buffer, { contentType: params.mimeType });
  if (error) throw error;
  return path;
}
