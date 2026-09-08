import { logger } from "../lib/logger.js";
import { resolverIdentidad, vincularIdentidadMensajeria } from "../meta/identidades.js";
import { getOrCreateConversacionAbierta } from "../db/repositories/conversaciones.js";
import { guardarMensaje, actualizarMetadataPorExternalId } from "../db/repositories/mensajes.js";
import { getCanalConfig } from "../db/repositories/canales.js";
import { registrarEvento } from "../db/repositories/eventos.js";
import { responderComentarioPrivado } from "../meta/client.js";
import type { CanalMeta, EventoMeta } from "../meta/parser.js";

const TIPO_IDENTIDAD_COMENTARIO: Record<CanalMeta, "fb_comment_user" | "ig_comment_user"> = {
  messenger: "fb_comment_user",
  instagram: "ig_comment_user",
};

const TIPO_IDENTIDAD_DM: Record<CanalMeta, "psid" | "igsid"> = { messenger: "psid", instagram: "igsid" };

type EventoComentario = Extract<EventoMeta, { kind: "comentario_nuevo" | "comentario_eliminado" }>;

/**
 * Un comentario de una persona en una publicación de Facebook o Instagram.
 * No abre la ventana de DM (eso solo lo hace un mensaje directo, ver
 * PROMPT-OMNICANAL.md §3.7) — la única forma de escribirle por privado a
 * quien solo comentó es la respuesta privada automática de acá abajo, o la
 * manual desde el panel (`POST /admin/comentarios/:id/responder`, fase 3).
 */
export async function handleComentario(evento: EventoComentario): Promise<void> {
  if (evento.kind === "comentario_eliminado") {
    // No se borra el mensaje: queda como rastro, solo marcado.
    await actualizarMetadataPorExternalId(evento.externalId, { eliminado: true }).catch((err: unknown) =>
      logger.error({ err, externalId: evento.externalId }, "No se pudo marcar el comentario como eliminado"),
    );
    return;
  }

  if (!evento.remitenteId) {
    // Meta no siempre manda `from` en un comentario (perfil restringido, o
    // simplemente no lo incluye). Sin remitente no hay a quién atribuírselo
    // ni con quién abrir conversación — se deja registrado en el log y nada
    // más, en vez de inventar una identidad.
    logger.warn({ externalId: evento.externalId, canal: evento.canal }, "Comentario sin remitente, se ignora");
    return;
  }

  const { cliente, identidad } = await resolverIdentidad({
    canal: evento.canal,
    tipo: TIPO_IDENTIDAD_COMENTARIO[evento.canal],
    externalId: evento.remitenteId,
    cuentaId: evento.cuentaId,
    nombreConocido: evento.canal === "messenger" ? evento.nombrePerfil : null,
    usernameConocido: evento.canal === "instagram" ? evento.nombrePerfil : null,
  });

  const conversacion = await getOrCreateConversacionAbierta({
    clienteId: cliente.id,
    canal: evento.canal,
    origen: "comentario",
    identidadId: identidad.id,
    cuentaId: evento.cuentaId,
    hiloExterno: evento.hiloExterno,
  });

  await guardarMensaje({
    conversacionId: conversacion.id,
    rol: "user",
    tipo: "comentario",
    contenido: evento.texto,
    externalId: evento.externalId,
    metadata: {
      ...(evento.hiloExterno ? { [evento.canal === "instagram" ? "media_id" : "post_id"]: evento.hiloExterno } : {}),
      ...(evento.parentId ? { parent_id: evento.parentId } : {}),
    },
  });

  const canalConfig = await getCanalConfig(evento.canal);
  // Solo al comentario original (no a una respuesta anidada) y solo con el
  // interruptor encendido de verdad — apagado por defecto porque Meta solo
  // deja UNA respuesta privada por comentario: gastarla con un texto mal
  // configurado no tiene vuelta atrás.
  const debeResponderPrivado =
    canalConfig?.activo && canalConfig.ia_comentarios_activa && canalConfig.texto_respuesta_privada && !evento.parentId;
  if (!debeResponderPrivado) return;

  const textoRespuesta = canalConfig.texto_respuesta_privada!;
  try {
    const resultado = await responderComentarioPrivado({ canal: evento.canal, commentId: evento.externalId, texto: textoRespuesta });

    // El recipient_id que devuelve ESTA llamada es la primera confirmación
    // real de que este comentarista y ese PSID/IGSID son la misma persona.
    const identidadDm = await vincularIdentidadMensajeria({
      clienteId: cliente.id,
      canal: evento.canal,
      tipo: TIPO_IDENTIDAD_DM[evento.canal],
      externalId: resultado.recipientId,
      cuentaId: evento.cuentaId,
    });
    const conversacionDm = await getOrCreateConversacionAbierta({
      clienteId: cliente.id,
      canal: evento.canal,
      origen: "dm",
      identidadId: identidadDm.id,
      cuentaId: evento.cuentaId,
    });

    await guardarMensaje({
      conversacionId: conversacionDm.id,
      rol: "assistant",
      contenido: textoRespuesta,
      externalId: resultado.messageId,
    });
    await guardarMensaje({
      conversacionId: conversacion.id,
      rol: "assistant",
      tipo: "sistema",
      contenido: "Respuesta privada enviada automáticamente.",
    });
    await actualizarMetadataPorExternalId(evento.externalId, { respondido_privado: true });
    await registrarEvento(conversacion.id, "respuesta_privada", { comment_id: evento.externalId }).catch((err: unknown) =>
      logger.error({ err }, "No se pudo registrar el evento de respuesta privada"),
    );
  } catch (err) {
    // Un fallo acá no debe tumbar nada más: el comentario ya quedó guardado
    // arriba, solo no salió la respuesta privada automática.
    logger.error({ err, externalId: evento.externalId, canal: evento.canal }, "No se pudo enviar la respuesta privada automática");
  }
}
