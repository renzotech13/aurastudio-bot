import { z } from "zod";

/**
 * Subconjunto de los payloads de webhook de Meta que nos interesa —
 * verificado contra la documentación oficial de Messenger Platform e
 * Instagram Platform antes de escribir esto (no se inventó ningún campo).
 * Meta manda muchos más campos (referral, quick_reply, reactions, message
 * tags…) que ignoramos a propósito: zod los descarta al no estar
 * declarados, igual que whatsapp/parser.ts.
 */

const metaAttachment = z.object({
  type: z.string(),
  payload: z.object({ url: z.string().optional() }).optional(),
});

const metaMessage = z.object({
  mid: z.string(),
  text: z.string().optional(),
  // true cuando el mensaje lo mandamos nosotros mismos (o alguien desde Meta
  // Business Suite) — nunca cuando lo manda la clienta.
  is_echo: z.boolean().optional(),
  attachments: z.array(metaAttachment).optional(),
  reply_to: z
    .object({
      mid: z.string().optional(),
      // Solo Instagram: responder a una historia.
      story: z.object({ id: z.string().optional(), url: z.string().optional() }).optional(),
    })
    .optional(),
});

const metaPostback = z.object({
  title: z.string().optional(),
  payload: z.string().optional(),
});

// Cubre mensaje, postback, eco, y también delivery/read (que llegan sin
// `message` ni `postback` — se detectan por ausencia y se ignoran, mismo
// criterio que "sent/delivered/read" en whatsapp/parser.ts).
const metaMessagingEvent = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: metaMessage.optional(),
  postback: metaPostback.optional(),
});

// object:"page", field:"feed" — comentarios de Facebook. `from` puede faltar
// (comentarista con perfil restringido, o Meta simplemente no lo manda en
// algunos casos) — nunca asumir que está.
const metaFeedValue = z.object({
  item: z.string(),
  verb: z.string(),
  comment_id: z.string().optional(),
  post_id: z.string().optional(),
  parent_id: z.string().optional(),
  from: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  message: z.string().optional(),
  created_time: z.union([z.string(), z.number()]).optional(),
});

// object:"instagram", field:"comments" — comentarios de Instagram. Sin
// `verb`: a diferencia de Facebook, este campo no distingue add/edit/remove
// en la documentación verificada — se trata siempre como comentario nuevo.
const metaIgCommentValue = z.object({
  id: z.string(),
  text: z.string().optional(),
  from: z.object({ id: z.string(), username: z.string().optional() }).optional(),
  media: z.object({ id: z.string().optional(), media_product_type: z.string().optional() }).optional(),
  parent_id: z.string().optional(),
});

const metaChange = z.object({
  field: z.string(),
  // Se valida específicamente según `field` al procesar, no acá — "feed" y
  // "comments" tienen formas distintas y una unión ambigua entre ellas
  // dejaría pasar valores que no calzan con ninguna.
  value: z.unknown(),
});

const metaEntry = z.object({
  id: z.string(),
  time: z.number().optional(),
  messaging: z.array(metaMessagingEvent).optional(),
  changes: z.array(metaChange).optional(),
});

const metaWebhookPayload = z.object({
  object: z.enum(["page", "instagram"]),
  entry: z.array(metaEntry),
});

export type CanalMeta = "messenger" | "instagram";
export type AttachmentType = "image" | "video" | "audio" | "file" | "share" | "story_mention" | "ig_reel" | "otro";

export type EventoMeta =
  | { kind: "dm_texto"; canal: CanalMeta; cuentaId: string; externalId: string; remitenteId: string; timestamp: Date; texto: string }
  | {
      kind: "dm_adjunto";
      canal: CanalMeta;
      cuentaId: string;
      externalId: string;
      remitenteId: string;
      timestamp: Date;
      attachmentType: AttachmentType;
      url: string;
    }
  | {
      kind: "dm_eco";
      canal: CanalMeta;
      cuentaId: string;
      externalId: string;
      /** El PSID/IGSID de la CLIENTA, no el nuestro — en un eco, sender es la página. */
      remitenteId: string;
      timestamp: Date;
      texto: string | null;
    }
  | {
      kind: "dm_postback";
      canal: CanalMeta;
      cuentaId: string;
      externalId: string;
      remitenteId: string;
      timestamp: Date;
      payload: string;
      titulo: string | null;
    }
  | {
      kind: "comentario_nuevo";
      canal: CanalMeta;
      cuentaId: string;
      externalId: string;
      /** Null si Meta no mandó `from` — se descarta con log, no se inventa. */
      remitenteId: string | null;
      nombrePerfil: string | null;
      timestamp: Date;
      texto: string;
      /** Id del post (Facebook) o del media (Instagram): así se agrupa el hilo. */
      hiloExterno: string | null;
      /** Si es una respuesta a otro comentario, no al post/media directamente. */
      parentId: string | null;
    }
  | {
      kind: "comentario_eliminado";
      canal: CanalMeta;
      cuentaId: string;
      externalId: string;
      remitenteId: string | null;
      timestamp: Date;
    }
  | {
      kind: "no_soportado";
      canal: CanalMeta;
      cuentaId: string;
      externalId: string;
      remitenteId: string | null;
      timestamp: Date;
      motivo: string;
    };

const ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "file",
  "share",
  "story_mention",
  "ig_reel",
]);

function normalizarAttachmentType(raw: string): AttachmentType {
  return ATTACHMENT_TYPES.has(raw) ? (raw as AttachmentType) : "otro";
}

/**
 * null si el payload calza con el esquema general de Meta; si no, el detalle
 * de zod — mismo criterio que whatsapp/parser.ts: un payload que no calza no
 * debe desaparecer en silencio, tiene que quedar rastro en el log.
 */
export function describeParsePayloadError(rawBody: unknown): string | null {
  const result = metaWebhookPayload.safeParse(rawBody);
  return result.success ? null : JSON.stringify(result.error.issues);
}

function procesarMessaging(canal: CanalMeta, cuentaId: string, ev: z.infer<typeof metaMessagingEvent>): EventoMeta | null {
  const timestamp = new Date(ev.timestamp);

  if (ev.message) {
    const msg = ev.message;

    if (msg.is_echo) {
      // En un eco, sender es la página/cuenta y recipient es la clienta —
      // al revés que en un mensaje entrante normal.
      return { kind: "dm_eco", canal, cuentaId, externalId: msg.mid, remitenteId: ev.recipient.id, timestamp, texto: msg.text ?? null };
    }

    if (msg.text) {
      return { kind: "dm_texto", canal, cuentaId, externalId: msg.mid, remitenteId: ev.sender.id, timestamp, texto: msg.text };
    }

    const attachment = msg.attachments?.[0];
    if (attachment?.payload?.url) {
      return {
        kind: "dm_adjunto",
        canal,
        cuentaId,
        externalId: msg.mid,
        remitenteId: ev.sender.id,
        timestamp,
        attachmentType: normalizarAttachmentType(attachment.type),
        url: attachment.payload.url,
      };
    }

    return {
      kind: "no_soportado",
      canal,
      cuentaId,
      externalId: msg.mid,
      remitenteId: ev.sender.id,
      timestamp,
      motivo: "Mensaje sin texto ni adjunto reconocible (¿reacción, sticker, comando?)",
    };
  }

  if (ev.postback) {
    return {
      kind: "dm_postback",
      canal,
      cuentaId,
      // Los postbacks no traen mid propio: no hay nada mejor con qué deduplicar.
      externalId: `postback:${ev.sender.id}:${ev.timestamp}`,
      remitenteId: ev.sender.id,
      timestamp,
      payload: ev.postback.payload ?? "",
      titulo: ev.postback.title ?? null,
    };
  }

  // delivery / read / reacciones: no traen `message` ni `postback`. Se
  // ignoran en silencio, igual que "sent"/"delivered"/"read" de WhatsApp —
  // no hay ninguna acción que tomar con esto hoy.
  return null;
}

function procesarFeedChange(canal: CanalMeta, cuentaId: string, valorCrudo: unknown): EventoMeta | null {
  const parsed = metaFeedValue.safeParse(valorCrudo);
  if (!parsed.success) return null;
  const v = parsed.data;

  if (v.item !== "comment") return null; // otros items del feed (post, photo, video…): fuera de alcance.
  // Nuestra propia respuesta pública llega de vuelta por acá: se descarta al
  // nacer, no vale la pena resolverle identidad ni conversación. El dedupe
  // por external_id (mensajes.external_id) es la red de seguridad para el
  // caso borde de que este filtro falle por algún motivo.
  if (v.from?.id === cuentaId) return null;

  const externalId = v.comment_id ?? `feed:${cuentaId}:${v.created_time ?? Date.now()}`;
  const timestamp = v.created_time ? new Date(v.created_time) : new Date();

  if (v.verb === "add") {
    if (!v.message) return null; // un "add" sin mensaje no es un comentario nuestro que atender.
    return {
      kind: "comentario_nuevo",
      canal,
      cuentaId,
      externalId,
      remitenteId: v.from?.id ?? null,
      nombrePerfil: v.from?.name ?? null,
      timestamp,
      texto: v.message,
      hiloExterno: v.post_id ?? null,
      parentId: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : null,
    };
  }

  if (v.verb === "remove") {
    return { kind: "comentario_eliminado", canal, cuentaId, externalId, remitenteId: v.from?.id ?? null, timestamp };
  }

  return {
    kind: "no_soportado",
    canal,
    cuentaId,
    externalId,
    remitenteId: v.from?.id ?? null,
    timestamp,
    motivo: `Verbo de comentario no manejado: ${v.verb}`,
  };
}

function procesarCommentsChange(canal: CanalMeta, cuentaId: string, valorCrudo: unknown): EventoMeta | null {
  const parsed = metaIgCommentValue.safeParse(valorCrudo);
  if (!parsed.success) return null;
  const v = parsed.data;
  if (!v.text) return null;
  if (v.from?.id === cuentaId) return null; // nuestra propia respuesta pública, ver comentario en procesarFeedChange.

  return {
    kind: "comentario_nuevo",
    canal,
    cuentaId,
    externalId: v.id,
    remitenteId: v.from?.id ?? null,
    nombrePerfil: v.from?.username ?? null,
    // Sin created_time documentado para este campo: se usa el momento de
    // recepción, que de todos modos es lo que queda en mensajes.created_at.
    timestamp: new Date(),
    texto: v.text,
    hiloExterno: v.media?.id ?? null,
    parentId: v.parent_id ?? null,
  };
}

/**
 * Extrae los eventos relevantes de un payload de webhook de Meta (Messenger
 * o Instagram, DMs o comentarios). Nuestra propia actividad (comentarios que
 * publicamos nosotros, respondiendo) llega igual por acá — se filtra en
 * handleComentario.ts comparando `remitenteId` contra `cuentaId`, no acá:
 * este parser solo interpreta la forma del payload, no decide de quién es.
 */
export function parseEventosMeta(rawBody: unknown): EventoMeta[] {
  const result = metaWebhookPayload.safeParse(rawBody);
  if (!result.success) return [];

  const canal: CanalMeta = result.data.object === "instagram" ? "instagram" : "messenger";
  const eventos: EventoMeta[] = [];

  for (const entry of result.data.entry) {
    for (const ev of entry.messaging ?? []) {
      const evento = procesarMessaging(canal, entry.id, ev);
      if (evento) eventos.push(evento);
    }

    for (const change of entry.changes ?? []) {
      let evento: EventoMeta | null = null;
      if (change.field === "feed") {
        evento = procesarFeedChange(canal, entry.id, change.value);
      } else if (change.field === "comments") {
        evento = procesarCommentsChange(canal, entry.id, change.value);
      } else {
        evento = {
          kind: "no_soportado",
          canal,
          cuentaId: entry.id,
          externalId: `change:${entry.id}:${change.field}:${Date.now()}`,
          remitenteId: null,
          timestamp: new Date(),
          motivo: `Campo de webhook no manejado: ${change.field}`,
        };
      }
      if (evento) eventos.push(evento);
    }
  }

  return eventos;
}
