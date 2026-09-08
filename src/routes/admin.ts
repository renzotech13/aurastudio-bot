import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env, whatsappConfigurado, metaConfigurado, instagramConfigurado } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { requireStaff } from "../lib/adminAuth.js";
import { normalizarTelefono } from "../lib/telefono.js";
import {
  getConversacionConDestino,
  getOrCreateConversacionAbierta,
} from "../db/repositories/conversaciones.js";
import { guardarMensaje, getMensajeById, actualizarMetadataPorExternalId } from "../db/repositories/mensajes.js";
import { getClienteById, findOrCreateByPhone, getClienteByTelefono, guardarTelefonoCliente, fusionarClientes } from "../db/repositories/clientes.js";
import { registrarEvento } from "../db/repositories/eventos.js";
import { reservarNotificacion, marcarEnviada, marcarFallida } from "../db/repositories/notificaciones.js";
import { actualizarEstadoCita, crearCitasConsecutivas } from "../db/repositories/citas.js";
import { getProfesionalEnSede } from "../db/repositories/profesionales.js";
import { getBloqueoPorId, eliminarBloqueoPorId } from "../db/repositories/bloqueos.js";
import { getPlantillaById, urlPublicaPlantilla } from "../db/repositories/plantillasMedia.js";
import { deleteCalendarEvent } from "../calendar/google.js";
import { sendTemplate, listarPlantillas } from "../whatsapp/client.js";
import { getCanalAdapter } from "../canales/index.js";
import { runAgent } from "../agent/runner.js";
import { responderComentarioPublico, responderComentarioPrivado, estadoConexion, marcarVisto } from "../meta/client.js";
import { vincularIdentidadMensajeria } from "../meta/identidades.js";
import type { CanalMeta } from "../meta/parser.js";

// Exactamente uno de los dos: o el staff escribe texto, o elige una
// plantilla multimedia de la biblioteca — nunca ambos ni ninguno.
const mensajeSchema = z
  .object({
    conversacionId: z.string().uuid(),
    texto: z.string().trim().min(1).max(4000).optional(),
    plantillaId: z.string().uuid().optional(),
  })
  .refine((data) => Boolean(data.texto) !== Boolean(data.plantillaId), {
    message: "Manda exactamente uno: texto o plantillaId",
  });

const promocionSchema = z.object({
  clienteIds: z.array(z.string().uuid()).min(1).max(200),
  plantilla: z.string().trim().min(1),
  parametros: z.array(z.string()).max(10).optional(),
});

const walkInSchema = z.object({
  // Una de las dos: la clienta ya existe, o se crea con teléfono y nombre.
  cliente_id: z.string().uuid().optional(),
  telefono: z.string().trim().min(6).optional(),
  nombre: z.string().trim().min(2).optional(),
  servicio_ids: z.array(z.string()).min(1).max(10),
  sede_id: z.string().min(1),
  profesional_id: z.string().uuid(),
  // ISO completo con zona; el panel lo arma desde la hora de Lima.
  inicio: z.string().datetime({ offset: true }),
  estado: z.enum(["confirmada", "completada"]).default("completada"),
  comentario: z.string().trim().max(1000).optional(),
}).refine((d) => Boolean(d.cliente_id) || Boolean(d.telefono), {
  message: "Manda cliente_id, o telefono para crearla",
});

const citaEstadoSchema = z.object({
  estado: z.enum(["confirmada", "cancelada", "completada", "no_asistio"]),
});

const comentarioResponderSchema = z.object({
  modo: z.enum(["publico", "privado"]),
  texto: z.string().trim().min(1).max(2000),
});

const clienteTelefonoSchema = z.object({
  telefono: z.string().trim().min(6),
  fusionar: z.boolean().optional(),
});

const SIETE_DIAS_MS = 7 * 24 * 60 * 60_000;

export async function adminRoutes(app: FastifyInstance) {
  /**
   * Respuesta escrita por un humano del staff desde el panel — WhatsApp,
   * Messenger o Instagram, el mismo endpoint para los tres.
   *
   * El envío va antes de guardar a propósito: si el canal rechaza el
   * mensaje, no queremos dejar en el historial algo que la clienta nunca
   * recibió (y que Claude luego leería como contexto real).
   */
  app.post("/admin/mensajes", async (request: FastifyRequest, reply: FastifyReply) => {
    const staff = await requireStaff(request.headers.authorization);

    const parsed = mensajeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const { conversacionId, texto, plantillaId } = parsed.data;

    const found = await getConversacionConDestino(conversacionId);
    if (!found) return reply.status(404).send({ error: "conversacion_no_encontrada" });

    if (!found.destinatarioId) {
      return reply.status(409).send({
        error: "sin_telefono",
        mensaje: "Todavía no se resolvió a quién enviarle: esta clienta no tiene una identidad de mensajería registrada.",
      });
    }

    const adapter = getCanalAdapter(found.conversacion.canal);
    const ultimoMensajeAt = found.conversacion.ultimo_mensaje_at;

    let mensaje;
    if (texto) {
      const resultado = await adapter.enviarTexto({ destinatarioId: found.destinatarioId, texto, rol: "humano", ultimoMensajeAt });
      if (!resultado.externalId) {
        return reply.status(409).send({ error: "ventana_cerrada", mensaje: resultado.motivoCierre });
      }
      mensaje = await guardarMensaje({ conversacionId, rol: "humano", contenido: texto, externalId: resultado.externalId, autorId: staff.id });
    } else {
      const plantilla = await getPlantillaById(plantillaId!);
      if (!plantilla) return reply.status(404).send({ error: "plantilla_no_encontrada" });

      const url = urlPublicaPlantilla(plantilla.storage_path);
      const resultado = await adapter.enviarMedia({
        destinatarioId: found.destinatarioId,
        tipo: plantilla.tipo,
        url,
        caption: plantilla.caption,
        rol: "humano",
        ultimoMensajeAt,
      });
      if (!resultado.externalId) {
        return reply.status(409).send({ error: "ventana_cerrada", mensaje: resultado.motivoCierre });
      }
      mensaje = await guardarMensaje({
        conversacionId,
        rol: "humano",
        contenido: `[${plantilla.tipo}] ${plantilla.nombre}`,
        mediaUrl: url,
        mediaType: plantilla.tipo,
        externalId: resultado.externalId,
        autorId: staff.id,
      });
    }

    logger.info({ conversacionId, canal: found.conversacion.canal }, "Mensaje humano enviado desde el panel");
    return reply.status(201).send({ mensaje });
  });

  /**
   * Responder un comentario de Facebook/Instagram: en público (respuesta
   * visible bajo el comentario) o en privado (Send API, una sola vez por
   * comentario, hasta 7 días desde que se creó).
   */
  app.post("/admin/comentarios/:mensajeId/responder", async (request: FastifyRequest, reply: FastifyReply) => {
    const staff = await requireStaff(request.headers.authorization);

    const parsed = comentarioResponderSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

    const { mensajeId } = request.params as { mensajeId: string };
    const comentario = await getMensajeById(mensajeId);
    if (!comentario || comentario.tipo !== "comentario" || !comentario.external_id) {
      return reply.status(404).send({ error: "comentario_no_encontrado" });
    }

    const conv = await getConversacionConDestino(comentario.conversacion_id);
    if (!conv) return reply.status(404).send({ error: "conversacion_no_encontrada" });
    const canal = conv.conversacion.canal;
    if (canal === "whatsapp") return reply.status(400).send({ error: "canal_no_soportado" });
    const canalMeta = canal as CanalMeta;

    if (parsed.data.modo === "publico") {
      const resultado = await responderComentarioPublico({ canal: canalMeta, commentId: comentario.external_id, texto: parsed.data.texto });
      const nuevo = await guardarMensaje({
        conversacionId: comentario.conversacion_id,
        rol: "humano",
        tipo: "comentario",
        contenido: parsed.data.texto,
        externalId: resultado.commentId,
        autorId: staff.id,
        metadata: { parent_id: comentario.external_id },
      });
      logger.info({ conversacionId: comentario.conversacion_id }, "Respuesta pública a comentario enviada desde el panel");
      return reply.status(201).send({ mensaje: nuevo });
    }

    // modo === "privado": Meta permite UNA por comentario, hasta 7 días.
    const yaRespondido = (comentario.metadata as Record<string, unknown> | null)?.respondido_privado === true;
    const pasaron7dias = Date.now() - new Date(comentario.created_at).getTime() > SIETE_DIAS_MS;
    if (yaRespondido || pasaron7dias) {
      return reply.status(409).send({ error: "comentario_no_admite_privado" });
    }

    const resultado = await responderComentarioPrivado({ canal: canalMeta, commentId: comentario.external_id, texto: parsed.data.texto });

    const identidadDm = await vincularIdentidadMensajeria({
      clienteId: conv.clienteId,
      canal: canalMeta,
      tipo: canalMeta === "instagram" ? "igsid" : "psid",
      externalId: resultado.recipientId,
      cuentaId: conv.conversacion.cuenta_id,
    });
    const conversacionDm = await getOrCreateConversacionAbierta({
      clienteId: conv.clienteId,
      canal: canalMeta,
      origen: "dm",
      identidadId: identidadDm.id,
      cuentaId: conv.conversacion.cuenta_id,
    });

    await guardarMensaje({
      conversacionId: conversacionDm.id,
      rol: "humano",
      contenido: parsed.data.texto,
      externalId: resultado.messageId,
      autorId: staff.id,
    });
    await guardarMensaje({
      conversacionId: comentario.conversacion_id,
      rol: "humano",
      tipo: "sistema",
      contenido: "Respuesta privada enviada desde el panel.",
      autorId: staff.id,
    });
    await actualizarMetadataPorExternalId(comentario.external_id, { respondido_privado: true });
    await registrarEvento(comentario.conversacion_id, "respuesta_privada", { comment_id: comentario.external_id }).catch((err: unknown) =>
      logger.error({ err }, "No se pudo registrar el evento de respuesta privada"),
    );

    logger.info({ conversacionId: comentario.conversacion_id }, "Respuesta privada a comentario enviada desde el panel");
    return reply.send({ conversacionDmId: conversacionDm.id });
  });

  /**
   * Borrador de respuesta para que el staff revise antes de mandar — nunca
   * envía ni guarda nada solo. `runAgent(..., { modo: "sugerir" })` excluye
   * las tools que mutan y no escala la conversación ante ningún fallo.
   */
  app.post("/admin/ia/sugerencia", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const parsed = z.object({ conversacionId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

    const conv = await getConversacionConDestino(parsed.data.conversacionId);
    if (!conv) return reply.status(404).send({ error: "conversacion_no_encontrada" });

    const texto = await runAgent(
      {
        canal: conv.conversacion.canal,
        conversacionId: conv.conversacion.id,
        clienteId: conv.clienteId,
        telefono: conv.clienteTelefono,
        contactName: conv.clienteNombre ?? undefined,
      },
      "(El staff pidió una sugerencia de respuesta — no hay un mensaje nuevo de la clienta. Usa el historial " +
        "reciente de esta conversación para redactar el siguiente mensaje que le mandaría el negocio.)",
      { modo: "sugerir" },
    );

    return reply.send({ texto });
  });

  /**
   * El panel necesita la misma lógica que la tool guardar_datos_contacto:
   * si el teléfono ya es de otra clienta, no se puede simplemente
   * sobreescribir (rompería el unique de clientes.telefono) — hay que
   * fusionar, y eso requiere una transacción que no se puede hacer por RLS
   * directo desde el navegador.
   */
  app.post("/admin/clientes/:id/telefono", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const parsed = clienteTelefonoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

    const { id } = request.params as { id: string };
    const cliente = await getClienteById(id);
    if (!cliente) return reply.status(404).send({ error: "cliente_no_encontrado" });

    const normalizado = normalizarTelefono(parsed.data.telefono);
    if (!normalizado) return reply.status(400).send({ error: "telefono_invalido" });

    const existente = await getClienteByTelefono(normalizado);
    if (existente && existente.id !== id) {
      if (!parsed.data.fusionar) {
        return reply.status(409).send({ error: "telefono_en_uso", clienteExistente: { id: existente.id, nombre: existente.nombre } });
      }
      await fusionarClientes(id, existente.id);
      logger.info({ origen: id, destino: existente.id }, "Clientas fusionadas desde el panel");
      return reply.send({ clienteId: existente.id, fusionado: true });
    }

    await guardarTelefonoCliente(id, normalizado);
    return reply.send({ clienteId: id, fusionado: false });
  });

  /**
   * Estado de conexión de cada canal — la página "Canales" del panel (fase
   * 5) lo usa para mostrar si Messenger/Instagram están de verdad
   * funcionando, no solo si las variables de entorno están cargadas.
   */
  app.get("/admin/canales/estado", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const meta = metaConfigurado ? await estadoConexion().catch(() => null) : null;

    return reply.send({
      whatsapp: { configurado: whatsappConfigurado, numero: env.WHATSAPP_PHONE_NUMBER_ID ?? null },
      messenger: {
        configurado: metaConfigurado,
        pagina: meta?.pagina?.nombre ?? null,
        suscrito: meta?.suscrita ?? false,
        tokenVence: meta?.tokenVenceEn ?? null,
      },
      instagram: {
        configurado: instagramConfigurado,
        cuenta: meta?.instagram?.id ?? null,
        username: meta?.instagram?.username ?? null,
      },
      // No vive en ninguna tabla — es una aprobación de Meta a nivel de app,
      // no un interruptor de negocio. El panel lo necesita para calcular el
      // mismo aviso de ventana que ve el bot (meta/window.ts) ANTES de que
      // el staff intente enviar, no solo después de que el bot lo rechace.
      metaHumanAgentAprobado: env.META_HUMAN_AGENT_APROBADO,
    });
  });

  /**
   * Marca como visto en Messenger/Instagram cuando el staff abre la
   * conversación. Puramente cosmético del lado de Meta (sender_action:
   * mark_seen) — sin equivalente en WhatsApp con lo que ya está integrado,
   * así que para ese canal no hace nada.
   */
  app.post("/admin/conversaciones/:id/visto", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const { id } = request.params as { id: string };
    const conv = await getConversacionConDestino(id);
    if (!conv) return reply.status(404).send({ error: "conversacion_no_encontrada" });

    if (conv.conversacion.canal !== "whatsapp" && conv.destinatarioId) {
      await marcarVisto({ canal: conv.conversacion.canal as CanalMeta, recipientId: conv.destinatarioId }).catch(() => {});
    }

    return reply.status(204).send();
  });

  /**
   * Plantillas de WhatsApp aprobadas por Meta (o pendientes/rechazadas, para
   * que el staff sepa por qué no aparecen como opción todavía). El panel las
   * usa para armar el envío de promociones sin que nadie tenga que copiar el
   * nombre a mano desde el Administrador de WhatsApp ni adivinar cuántas
   * variables lleva el cuerpo.
   */
  app.get("/admin/plantillas", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);
    const plantillas = await listarPlantillas();
    return reply.send({ plantillas });
  });

  /**
   * Envío masivo de una plantilla (promociones). Siempre por plantilla
   * aprobada: una campaña sale casi siempre fuera de la ventana de 24h, y
   * mezclar los dos caminos haría que el resultado dependa de cuándo
   * escribió cada clienta por última vez. Solo WhatsApp: Messenger/Instagram
   * no tienen un equivalente de plantilla fuera de ventana.
   */
  app.post("/admin/promociones", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const parsed = promocionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const { clienteIds, plantilla, parametros } = parsed.data;

    let enviadas = 0;
    const fallidas: { clienteId: string; motivo: string }[] = [];

    for (const clienteId of clienteIds) {
      // Se resuelve la clienta ANTES de reservar la notificación: a una sin
      // teléfono no hay campaña que mandarle (llegó por Instagram o Messenger
      // y todavía no lo dio), y reservar primero dejaría una notificación
      // colgada que ningún reintento va a poder completar.
      const cliente = await getClienteById(clienteId);
      if (!cliente?.telefono) {
        logger.info({ clienteId }, "Clienta sin teléfono, se salta de la campaña");
        continue;
      }

      const notificacion = await reservarNotificacion({ clienteId, tipo: "promocion", plantilla });
      if (!notificacion) continue;

      try {
        await sendTemplate({
          to: cliente.telefono,
          plantilla,
          idioma: env.WHATSAPP_TEMPLATE_LANG,
          ...(parametros ? { parametros } : {}),
        });
        await marcarEnviada(notificacion.id);
        enviadas++;
      } catch (err) {
        const motivo = err instanceof Error ? err.message : String(err);
        await marcarFallida(notificacion.id, motivo).catch(() => {});
        fallidas.push({ clienteId, motivo });
        logger.error({ err, clienteId }, "Falló el envío de promoción");
      }
    }

    logger.info({ enviadas, fallidas: fallidas.length, plantilla }, "Campaña de promoción procesada");
    return reply.send({ enviadas, fallidas });
  });

  /**
   * Registrar a una clienta que llegó sin reservar.
   *
   * Va por el bot y no por un insert directo desde el navegador por dos
   * razones: acá vive la validación de solapamiento (que sigue aplicando —
   * una profesional no atiende a dos a la vez aunque lo anote recepción) y
   * las credenciales de Google Calendar.
   *
   * `omitirAntelacion` es la diferencia con una reserva normal: la política
   * de 2 horas de anticipación existe para quien reserva sola, no para
   * recepción anotando lo que está pasando en este momento o acaba de pasar.
   */
  app.post("/admin/citas", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const parsed = walkInSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    const body = parsed.data;

    const cliente = body.cliente_id
      ? await getClienteById(body.cliente_id)
      : await findOrCreateByPhone(body.telefono!, body.nombre);
    if (!cliente) return reply.status(404).send({ error: "cliente_no_encontrado" });

    const prof = await getProfesionalEnSede(body.profesional_id, body.sede_id);
    if (!prof) return reply.status(400).send({ error: "profesional_no_encontrada" });

    const resultado = await crearCitasConsecutivas({
      clienteId: cliente.id,
      servicioIds: body.servicio_ids,
      inicioUtc: new Date(body.inicio),
      creadaPor: "humano",
      profesionalId: prof.id,
      sedeId: body.sede_id,
      omitirAntelacion: true,
      estado: body.estado,
      ...(body.comentario ? { notas: body.comentario } : {}),
    });

    if (!resultado.ok) {
      logger.warn({ reason: resultado.reason }, "Walk-in rechazado");
      return reply.status(409).send({ error: resultado.reason, servicio_id_fallido: resultado.servicioIdFallido });
    }

    logger.info({ clienteId: cliente.id, cantidad: resultado.citas.length }, "Walk-in registrado desde el panel");
    return reply.status(201).send({ citas: resultado.citas, cliente });
  });

  /**
   * Cambiar el estado de una cita desde el panel. Pasa por acá (no un
   * update directo a Supabase desde el navegador) justo para poder borrar
   * el evento de Calendar al cancelar — el navegador nunca tiene las
   * credenciales de la service account, solo el bot las tiene.
   */
  app.post("/admin/citas/:id/estado", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const parsed = citaEstadoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

    const { id } = request.params as { id: string };
    const cita = await actualizarEstadoCita(id, parsed.data.estado);
    if (!cita) return reply.status(404).send({ error: "cita_no_encontrada" });

    logger.info({ citaId: id, estado: parsed.data.estado }, "Estado de cita actualizado desde el panel");
    return reply.send({ cita });
  });

  /**
   * Borrar un bloqueo desde el panel. Si vino de un evento externo de
   * Calendar (tiene google_event_id), borra también ese evento — si no,
   * el evento se queda huérfano en el calendario del negocio aunque acá
   * ya no exista el bloqueo.
   */
  app.post("/admin/bloqueos/:id/eliminar", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const { id } = request.params as { id: string };
    const bloqueo = await getBloqueoPorId(id);
    if (!bloqueo) return reply.status(404).send({ error: "bloqueo_no_encontrado" });

    if (bloqueo.google_event_id) {
      await deleteCalendarEvent(bloqueo.google_event_id);
    }
    await eliminarBloqueoPorId(id);

    logger.info({ bloqueoId: id }, "Bloqueo eliminado desde el panel");
    return reply.status(204).send();
  });
}
