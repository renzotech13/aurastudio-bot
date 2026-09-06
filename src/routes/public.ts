import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { isRateLimited } from "../lib/rateLimit.js";
import { consultarDisponibilidadReal, elegirProfesionalLibre } from "../lib/disponibilidadService.js";
import { getServiceById } from "../db/repositories/services.js";
import { findOrCreateByPhone } from "../db/repositories/clientes.js";
import { crearCitasConsecutivas } from "../db/repositories/citas.js";
import {
  getProfesionalById,
  listarProfesionalesParaServicios,
  listarSedes,
} from "../db/repositories/profesionales.js";
import { timeStringToUtcDate } from "../lib/availability.js";
import { BUSINESS_TIMEZONE } from "../config/business.js";

const FECHA_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HORA_REGEX = /^\d{2}:\d{2}$/;

const disponibilidadQuerySchema = z.object({
  servicio_ids: z.string().min(1),
  fecha_desde: z.string().regex(FECHA_REGEX),
  fecha_hasta: z.string().regex(FECHA_REGEX).optional(),
  sede_id: z.string().min(1).optional(),
  // Ausente = "cualquier profesional": se consideran todas las de la sede que
  // hagan los servicios pedidos.
  profesional_id: z.string().uuid().optional(),
});

const equipoQuerySchema = z.object({
  servicio_ids: z.string().min(1),
  sede_id: z.string().min(1),
});

const reservaBodySchema = z.object({
  servicio_ids: z.array(z.string()).min(1).max(10),
  fecha: z.string().regex(FECHA_REGEX),
  hora: z.string().regex(HORA_REGEX),
  nombre: z.string().trim().min(2),
  telefono: z.string().trim().min(6),
  primera_visita: z.boolean().nullable().optional(),
  comentario: z.string().trim().max(1000).optional(),
  // Opcional a propósito: el modal que está en producción todavía no lo
  // manda, y hacerlo obligatorio rompería toda reserva web entre el deploy
  // del bot y el del sitio (no son atómicos). Sin sede se usa la primera
  // activa, que hoy es Los Olivos — el único local operando.
  sede_id: z.string().min(1).optional(),
  profesional_id: z.string().uuid().nullable().optional(),
});

/**
 * /public/* es la única superficie del bot que habla con cualquier
 * visitante del sitio, sin autenticación — de ahí el rate limit por IP
 * (RATE_LIMIT_MAX_PER_MINUTE de WhatsApp usa el teléfono como llave, que
 * acá todavía no existe en la consulta de disponibilidad).
 */
export async function publicRoutes(app: FastifyInstance) {
  app.get("/public/disponibilidad", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isRateLimited(`disp:${request.ip}`, env.PUBLIC_RATE_LIMIT_MAX_PER_MINUTE)) {
      return reply.status(429).send({ error: "demasiadas_solicitudes" });
    }

    const parsed = disponibilidadQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_query", detail: parsed.error.issues });

    const servicioIds = parsed.data.servicio_ids.split(",").filter(Boolean);
    const servicios = await Promise.all(servicioIds.map((id) => getServiceById(id)));
    if (servicios.some((s) => !s?.duration_minutes)) {
      return reply.status(400).send({ error: "servicio_no_encontrado" });
    }
    // Servicios elegidos juntos se agendan consecutivos, así que el hueco
    // que hace falta es la suma de sus duraciones, no la de uno solo.
    const duracionTotal = servicios.reduce((sum, s) => sum + s!.duration_minutes!, 0);

    const fechaHasta = parsed.data.fecha_hasta ?? parsed.data.fecha_desde;
    if (fechaHasta < parsed.data.fecha_desde) return reply.status(400).send({ error: "rango_invalido" });

    // Quiénes pueden atender esto. Si la clienta eligió profesional, es una
    // sola; si eligió "cualquiera", son todas las de la sede que hagan los
    // servicios pedidos y la hora se ofrece si alguna la tiene libre.
    let profesionalIds: string[] = [];
    if (parsed.data.profesional_id) {
      const prof = await getProfesionalById(parsed.data.profesional_id);
      if (!prof) return reply.status(400).send({ error: "profesional_no_encontrada" });
      profesionalIds = [prof.id];
    } else if (parsed.data.sede_id) {
      const equipo = await listarProfesionalesParaServicios({
        sedeId: parsed.data.sede_id,
        servicioIds,
      });
      profesionalIds = equipo.map((p) => p.id);
      // Nadie en esa sede hace ese combo: no hay horas, y decirlo con una
      // lista vacía es más honesto que devolver la agenda del local entero.
      if (profesionalIds.length === 0) {
        return reply.send([]);
      }
    }

    const disponibilidad = await consultarDisponibilidadReal({
      duracionMinutos: duracionTotal,
      fechaDesde: parsed.data.fecha_desde,
      fechaHasta,
      profesionalIds,
    });
    return reply.send(disponibilidad);
  });

  /** Sedes y equipo disponible para un combo de servicios (paso 2 del modal). */
  app.get("/public/sedes", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isRateLimited(`sed:${request.ip}`, env.PUBLIC_RATE_LIMIT_MAX_PER_MINUTE)) {
      return reply.status(429).send({ error: "demasiadas_solicitudes" });
    }
    return reply.send(await listarSedes());
  });

  app.get("/public/equipo", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isRateLimited(`eq:${request.ip}`, env.PUBLIC_RATE_LIMIT_MAX_PER_MINUTE)) {
      return reply.status(429).send({ error: "demasiadas_solicitudes" });
    }
    const parsed = equipoQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_query", detail: parsed.error.issues });

    const equipo = await listarProfesionalesParaServicios({
      sedeId: parsed.data.sede_id,
      servicioIds: parsed.data.servicio_ids.split(",").filter(Boolean),
    });
    return reply.send(
      equipo.map((p) => ({ id: p.id, nombre: p.nombre, rol: p.rol, foto_url: p.foto_url })),
    );
  });

  app.post("/public/reservas", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isRateLimited(`res:${request.ip}`, env.PUBLIC_RATE_LIMIT_MAX_PER_MINUTE)) {
      return reply.status(429).send({ error: "demasiadas_solicitudes" });
    }

    const parsed = reservaBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    const body = parsed.data;

    const cliente = await findOrCreateByPhone(body.telefono, body.nombre);
    const inicioUtc = timeStringToUtcDate(body.fecha, body.hora, BUSINESS_TIMEZONE);

    // La cita NUNCA se guarda sin profesional: con profesional_id null no
    // chocaría con ninguna otra (el EXCLUDE de la 0014 filtra por
    // "profesional_id is not null") y se podrían apilar clientas a la misma
    // hora. "Cualquiera" se resuelve acá a una persona concreta.
    const servicios = await Promise.all(body.servicio_ids.map((id) => getServiceById(id)));
    if (servicios.some((s) => !s?.duration_minutes)) {
      return reply.status(400).send({ error: "servicio_no_encontrado" });
    }
    const duracionTotal = servicios.reduce((sum, s) => sum + s!.duration_minutes!, 0);
    const finUtc = new Date(inicioUtc.getTime() + duracionTotal * 60_000);

    const sedeId = body.sede_id ?? (await listarSedes())[0]?.id;
    if (!sedeId) return reply.status(500).send({ error: "sin_sedes_configuradas" });

    let profesionalId: string | null = null;
    if (body.profesional_id) {
      const prof = await getProfesionalById(body.profesional_id);
      if (!prof || prof.sede_id !== sedeId) {
        return reply.status(400).send({ error: "profesional_no_encontrada" });
      }
      profesionalId = prof.id;
    } else {
      const equipo = await listarProfesionalesParaServicios({
        sedeId,
        servicioIds: body.servicio_ids,
      });
      profesionalId = await elegirProfesionalLibre({
        profesionalIds: equipo.map((p) => p.id),
        inicioUtc,
        finUtc,
      });
      if (!profesionalId) {
        // Alguien tomó la última profesional libre entre que se pintó el
        // horario y este POST.
        return reply.status(409).send({ error: "conflicto_horario" });
      }
    }

    // primera_visita no tiene columna propia en citas (bookings sí la tenía)
    // — se conserva igual como contexto legible para el staff, en vez de
    // perderse en el camino.
    const notasPartes: string[] = [];
    if (body.primera_visita === true) notasPartes.push("Primera visita: sí");
    if (body.primera_visita === false) notasPartes.push("Primera visita: no");
    if (body.comentario) notasPartes.push(body.comentario);
    const notas = notasPartes.length > 0 ? notasPartes.join(" — ") : undefined;

    const resultado = await crearCitasConsecutivas({
      clienteId: cliente.id,
      servicioIds: body.servicio_ids,
      inicioUtc,
      creadaPor: "humano",
      profesionalId,
      sedeId,
      ...(notas ? { notas } : {}),
    });

    if (!resultado.ok) {
      logger.warn({ reason: resultado.reason, servicioIdFallido: resultado.servicioIdFallido }, "Reserva web rechazada");
      return reply.status(409).send({ error: resultado.reason, servicio_id_fallido: resultado.servicioIdFallido });
    }

    logger.info({ clienteId: cliente.id, cantidad: resultado.citas.length }, "Reserva web creada");
    return reply.status(201).send({
      citas: resultado.citas.map((c) => ({ id: c.id, servicio_id: c.servicio_id, inicio_utc: c.inicio_utc, fin_utc: c.fin_utc })),
    });
  });
}
