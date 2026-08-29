import { z } from "zod";

// Subconjunto del payload de Meta que nos interesa. Meta envía más campos
// (statuses, reactions, system, etc.) que ignoramos deliberadamente aquí;
// zod los descarta al no estar declarados (no usamos passthrough).
const metaTextMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});

const metaAudioMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("audio"),
  audio: z.object({ id: z.string(), mime_type: z.string().optional() }),
});

const metaImageMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("image"),
  image: z.object({ id: z.string(), mime_type: z.string().optional() }),
});

const metaInteractiveMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("interactive"),
  interactive: z.union([
    z.object({
      type: z.literal("button_reply"),
      button_reply: z.object({ id: z.string(), title: z.string() }),
    }),
    z.object({
      type: z.literal("list_reply"),
      list_reply: z.object({ id: z.string(), title: z.string() }),
    }),
  ]),
});

// Cualquier otro type (image, sticker, location, reaction, unsupported...)
// se acepta laxamente para poder identificarlo y descartarlo sin que zod
// tire el mensaje completo del webhook.
const metaOtherMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
});

const metaMessage = z.union([
  metaTextMessage,
  metaAudioMessage,
  metaImageMessage,
  metaInteractiveMessage,
  metaOtherMessage,
]);

const metaContact = z.object({
  wa_id: z.string(),
  profile: z.object({ name: z.string() }).optional(),
});

const metaStatus = z.object({
  id: z.string(),
  status: z.string(),
  errors: z
    .array(z.object({ code: z.number().optional(), title: z.string().optional(), message: z.string().optional() }))
    .optional(),
});

const metaChangeValue = z.object({
  messaging_product: z.literal("whatsapp"),
  metadata: z.object({
    display_phone_number: z.string().optional(),
    phone_number_id: z.string(),
  }),
  contacts: z.array(metaContact).optional(),
  messages: z.array(metaMessage).optional(),
  // Delivery/read receipts de mensajes que MANDAMOS nosotros (no de los que
  // recibimos). Solo nos interesa "failed": un envío que Meta aceptó
  // (200 OK, wa_message_id asignado) pero no pudo entregar después — típico
  // cuando no logra descargar un media por link. "sent"/"delivered"/"read"
  // se ignoran a propósito, no hay ninguna acción que tomar con esos.
  statuses: z.array(metaStatus).optional(),
});

const metaWebhookPayload = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          value: metaChangeValue,
          field: z.string(),
        }),
      ),
    }),
  ),
});

export type InboundMessage =
  | { kind: "text"; id: string; from: string; timestamp: string; contactName?: string; text: string }
  | { kind: "audio"; id: string; from: string; timestamp: string; contactName?: string; mediaId: string }
  | { kind: "image"; id: string; from: string; timestamp: string; contactName?: string; mediaId: string; mimeType: string }
  | {
      kind: "interactive_reply";
      id: string;
      from: string;
      timestamp: string;
      contactName?: string;
      replyId: string;
      replyTitle: string;
    }
  | { kind: "unsupported"; id: string; from: string; timestamp: string; contactName?: string; messageType: string };

/**
 * null si el payload calza con lo que Meta debería mandar; si no, el
 * detalle de zod — para poder loguearlo en vez de descartar el webhook en
 * silencio absoluto (pasó al menos una vez: un mensaje entrante que jamás
 * dejó rastro en ningún lado, ni siquiera un log, porque no calzaba con el
 * esquema y las dos funciones de abajo simplemente devuelven []).
 */
export function describeParsePayloadError(rawBody: unknown): string | null {
  const result = metaWebhookPayload.safeParse(rawBody);
  return result.success ? null : JSON.stringify(result.error.issues);
}

export type FailedStatus = { waMessageId: string; errorMessage: string };

/**
 * Extrae solo los eventos de estado "failed" (envíos nuestros que Meta no
 * pudo entregar). El resto de estados ("sent", "delivered", "read") se
 * descarta acá mismo: no hay nada que hacer con ellos hoy.
 */
export function parseFailedStatuses(rawBody: unknown): FailedStatus[] {
  const result = metaWebhookPayload.safeParse(rawBody);
  if (!result.success) return [];

  const fallidos: FailedStatus[] = [];
  for (const entry of result.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages" || !change.value.statuses) continue;
      for (const status of change.value.statuses) {
        if (status.status !== "failed") continue;
        const detalle = status.errors?.[0];
        const errorMessage = detalle
          ? `${detalle.title ?? "Error"} (${detalle.code ?? "sin código"})${detalle.message ? `: ${detalle.message}` : ""}`
          : "Meta reportó el envío como fallido, sin detalle.";
        fallidos.push({ waMessageId: status.id, errorMessage });
      }
    }
  }
  return fallidos;
}

/**
 * Extrae los mensajes de usuario relevantes de un payload de webhook de Meta.
 * Devuelve una lista vacía para payloads que no traen mensajes de usuario
 * (p. ej. actualizaciones de estado de entrega/lectura).
 */
export function parseInboundMessages(rawBody: unknown): InboundMessage[] {
  const result = metaWebhookPayload.safeParse(rawBody);
  if (!result.success) return [];

  const messages: InboundMessage[] = [];

  for (const entry of result.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages" || !change.value.messages) continue;

      const contactByWaId = new Map(
        (change.value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name] as const),
      );

      for (const msg of change.value.messages) {
        const contactName = contactByWaId.get(msg.from);
        const base = { id: msg.id, from: msg.from, timestamp: msg.timestamp, ...(contactName ? { contactName } : {}) };

        if (msg.type === "text" && "text" in msg) {
          messages.push({ kind: "text", ...base, text: msg.text.body });
        } else if (msg.type === "audio" && "audio" in msg) {
          messages.push({ kind: "audio", ...base, mediaId: msg.audio.id });
        } else if (msg.type === "image" && "image" in msg) {
          messages.push({
            kind: "image",
            ...base,
            mediaId: msg.image.id,
            mimeType: msg.image.mime_type ?? "image/jpeg",
          });
        } else if (msg.type === "interactive" && "interactive" in msg) {
          const reply = msg.interactive.type === "button_reply" ? msg.interactive.button_reply : msg.interactive.list_reply;
          messages.push({ kind: "interactive_reply", ...base, replyId: reply.id, replyTitle: reply.title });
        } else {
          messages.push({ kind: "unsupported", ...base, messageType: msg.type });
        }
      }
    }
  }

  return messages;
}
