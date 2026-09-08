import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import type { CanalMeta, AttachmentType } from "./parser.js";
import type { ModoEnvioMeta } from "./window.js";

export const GRAPH_BASE_URL = `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

function tokenRequerido(): string {
  if (!env.META_PAGE_ACCESS_TOKEN) {
    throw new AppError("Falta META_PAGE_ACCESS_TOKEN", "meta_no_configurado", 500);
  }
  return env.META_PAGE_ACCESS_TOKEN;
}

async function llamarGraphApi(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = `${GRAPH_BASE_URL}${path}?access_token=${encodeURIComponent(tokenRequerido())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    logger.error({ status: res.status, errorBody, path }, "Falló una llamada a la Graph API de Meta");
    throw new AppError("No se pudo completar la acción en Meta", "meta_api_failed", 502);
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Ambos canales mandan por acá: cuando Instagram se integra por "Instagram
 * API con Facebook Login" (la vía que elegimos, ver PROMPT-OMNICANAL.md §3.2)
 * reutiliza la infraestructura de la página en vez de graph.instagram.com —
 * mismo endpoint que Messenger, con el Page Access Token, y el `recipient.id`
 * como IGSID en vez de PSID. Verificado contra la documentación disponible al
 * momento de escribir esto (no hay un ejemplo explícito lado a lado en la
 * referencia oficial); confirmar con un envío real apenas haya credenciales
 * activas — si Meta lo rechaza, la alternativa a probar es
 * `/{META_IG_ACCOUNT_ID}/messages`.
 */
function messagingType(modo: ModoEnvioMeta): Record<string, unknown> {
  return modo === "HUMAN_AGENT"
    ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
    : { messaging_type: "RESPONSE" };
}

export type EnvioMetaResultado = { messageId: string; recipientId: string };

export async function enviarTexto(params: {
  canal: CanalMeta;
  recipientId: string;
  texto: string;
  modo: ModoEnvioMeta;
}): Promise<EnvioMetaResultado> {
  const data = await llamarGraphApi(`/${env.META_PAGE_ID}/messages`, {
    recipient: { id: params.recipientId },
    message: { text: params.texto },
    ...messagingType(params.modo),
  });
  return { messageId: String(data.message_id ?? ""), recipientId: String(data.recipient_id ?? params.recipientId) };
}

const TIPO_ATTACHMENT_ENVIO: Partial<Record<AttachmentType, string>> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "file",
};

export async function enviarAdjunto(params: {
  canal: CanalMeta;
  recipientId: string;
  tipo: AttachmentType;
  url: string;
  modo: ModoEnvioMeta;
}): Promise<EnvioMetaResultado> {
  const tipoGraph = TIPO_ATTACHMENT_ENVIO[params.tipo] ?? "file";
  const data = await llamarGraphApi(`/${env.META_PAGE_ID}/messages`, {
    recipient: { id: params.recipientId },
    message: { attachment: { type: tipoGraph, payload: { url: params.url, is_reusable: true } } },
    ...messagingType(params.modo),
  });
  return { messageId: String(data.message_id ?? ""), recipientId: String(data.recipient_id ?? params.recipientId) };
}

/**
 * Responde en privado a quien comentó — Meta permite UNA por comentario,
 * hasta 7 días después. El `recipientId` que devuelve es el PSID/IGSID real
 * de esa persona: es lo que permite enlazar el comentario con su identidad
 * de DM (ver meta/identidades.ts), porque `from.id` de un comentario NO es
 * el mismo espacio de ids que el de mensajería.
 */
export async function responderComentarioPrivado(params: {
  canal: CanalMeta;
  commentId: string;
  texto: string;
}): Promise<EnvioMetaResultado> {
  const data = await llamarGraphApi(`/${env.META_PAGE_ID}/messages`, {
    recipient: { comment_id: params.commentId },
    message: { text: params.texto },
  });
  const recipientId = data.recipient_id;
  if (!recipientId) {
    // Sin recipient_id no hay con qué enlazar la identidad de DM — mejor
    // fallar alto y dejarlo visible que guardar una identidad rota.
    throw new AppError("Meta no devolvió recipient_id en la respuesta privada", "meta_send_failed", 502);
  }
  return { messageId: String(data.message_id ?? ""), recipientId: String(recipientId) };
}

/** Facebook: POST /{comment-id}/comments. Instagram: POST /{comment-id}/replies. Verificado en la documentación oficial. */
export async function responderComentarioPublico(params: {
  canal: CanalMeta;
  commentId: string;
  texto: string;
}): Promise<{ commentId: string }> {
  const path = params.canal === "instagram" ? `/${params.commentId}/replies` : `/${params.commentId}/comments`;
  const data = await llamarGraphApi(path, { message: params.texto });
  return { commentId: String(data.id ?? "") };
}

export type PerfilMeta = { nombre: string | null; username: string | null; fotoUrl: string | null };

/**
 * Nunca bloquea el flujo: un perfil que no se pudo leer no debe tumbar la
 * recepción de un mensaje. Messenger da nombre y apellido; Instagram da
 * username — se homogeniza en `nombre` para lo que sí tienen ambos.
 */
export async function obtenerPerfil(params: { canal: CanalMeta; id: string }): Promise<PerfilMeta | null> {
  try {
    const campos = params.canal === "instagram" ? "name,username,profile_pic" : "first_name,last_name,profile_pic";
    const url = `${GRAPH_BASE_URL}/${params.id}?fields=${campos}&access_token=${encodeURIComponent(tokenRequerido())}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;

    const nombre =
      params.canal === "instagram"
        ? (data.name as string | undefined)
        : [data.first_name, data.last_name].filter(Boolean).join(" ") || null;

    return {
      nombre: nombre || null,
      username: (data.username as string | undefined) ?? null,
      fotoUrl: (data.profile_pic as string | undefined) ?? null,
    };
  } catch (err) {
    logger.warn({ err, canal: params.canal, id: params.id }, "No se pudo obtener el perfil de Meta");
    return null;
  }
}

/** Las URLs de adjuntos entrantes de Meta caducan: hay que descargar al momento de recibirlas. */
export async function descargarAdjunto(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new AppError("No se pudo descargar el adjunto de Meta", "meta_media_download_failed", 502);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
  return { buffer, mimeType };
}

/**
 * `sender_action: mark_seen` — opcional, se llama cuando el staff abre la
 * conversación. No documentado explícitamente para Instagram: si Meta lo
 * rechaza para ese canal, se ignora el error sin más (nunca es crítico).
 */
export async function marcarVisto(params: { canal: CanalMeta; recipientId: string }): Promise<void> {
  try {
    await llamarGraphApi(`/${env.META_PAGE_ID}/messages`, {
      recipient: { id: params.recipientId },
      sender_action: "mark_seen",
    });
  } catch (err) {
    logger.warn({ err, canal: params.canal }, "No se pudo marcar como visto (no crítico)");
  }
}

export type EstadoConexionMeta = {
  pagina: { id: string; nombre: string | null } | null;
  instagram: { id: string; username: string | null } | null;
  suscrita: boolean;
  tokenVenceEn: string | null;
};

/**
 * Salud de la conexión: se llama al arrancar el servidor (sin bloquear) y
 * desde `GET /admin/canales/estado`. Nunca lanza — un fallo acá no debe
 * tumbar el arranque del bot, solo dejar la info en null.
 */
export async function estadoConexion(): Promise<EstadoConexionMeta | null> {
  if (!env.META_PAGE_ID || !env.META_PAGE_ACCESS_TOKEN) return null;
  const token = env.META_PAGE_ACCESS_TOKEN;

  try {
    const [paginaRes, suscritosRes, debugRes] = await Promise.all([
      fetch(
        `${GRAPH_BASE_URL}/${env.META_PAGE_ID}?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`,
      ),
      fetch(`${GRAPH_BASE_URL}/${env.META_PAGE_ID}/subscribed_apps?access_token=${encodeURIComponent(token)}`),
      fetch(`${GRAPH_BASE_URL}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`),
    ]);

    const pagina = paginaRes.ok ? ((await paginaRes.json()) as Record<string, unknown>) : null;
    const suscritos = suscritosRes.ok ? ((await suscritosRes.json()) as { data?: unknown[] }) : null;
    const debug = debugRes.ok ? ((await debugRes.json()) as { data?: { expires_at?: number } }) : null;

    const ig = pagina?.instagram_business_account as { id?: string; username?: string } | undefined;
    const expiresAt = debug?.data?.expires_at;

    return {
      pagina: pagina ? { id: String(pagina.id ?? ""), nombre: (pagina.name as string | undefined) ?? null } : null,
      instagram: ig?.id ? { id: ig.id, username: ig.username ?? null } : null,
      suscrita: Boolean(suscritos?.data && suscritos.data.length > 0),
      // 0 = sin vencimiento (token permanente); lo dejamos explícito como null.
      tokenVenceEn: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
    };
  } catch (err) {
    logger.warn({ err }, "No se pudo consultar el estado de conexión de Meta");
    return null;
  }
}
