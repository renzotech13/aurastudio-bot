import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { logger } from "../lib/logger.js";
import { requireProfesional } from "../lib/adminAuth.js";
import { normalizarTelefono } from "../lib/telefono.js";
import {
  atencionSchema,
  citaEsDeProfesional,
  estadoSchema,
  inicioEnRango,
  serviciosNoPermitidos,
  ventaSchema,
} from "../lib/equipoReglas.js";
import { actualizarEstadoCita, crearCitasConsecutivas } from "../db/repositories/citas.js";
import { findOrCreateByPhone, getClienteById } from "../db/repositories/clientes.js";
import { getProfesionalEnSede } from "../db/repositories/profesionales.js";
import {
  cajaAbiertaEnSede,
  clienteEsDeProfesional,
  getCitaPorId,
  registrarVentaProducto,
  serviciosDeProfesional,
} from "../db/repositories/equipo.js";

/**
 * Lo que una profesional hace desde su app. Todo va por acá y no por un
 * insert directo desde el navegador por lo mismo que las rutas de recepción:
 * acá viven la validación de solapamiento y las credenciales de Google
 * Calendar. Y además porque la profesional no tiene —ni debe tener— permiso
 * de escritura sobre citas ni caja en la base.
 *
 * Toda ruta empieza por requireProfesional() y filtra por SU profesionalId.
 * Ninguna acepta un `profesional_id` del cuerpo: siempre es ella.
 *
 * Las respuestas son mínimas a propósito. Las de /admin/* devuelven la fila
 * completa de la clienta (con teléfono y notas); acá no, porque la profesional
 * puede llegar a una clienta que no es suya escribiendo un teléfono, y la
 * respuesta no puede servirle para leer sus datos.
 */
export async function equipoRoutes(app: FastifyInstance): Promise<void> {
  /** Marcar una cita suya: atendida, no vino, cancelada o de nuevo confirmada. */
  app.post("/equipo/citas/:id/estado", async (request: FastifyRequest, reply: FastifyReply) => {
    const yo = await requireProfesional(request.headers.authorization);

    const parsed = estadoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

    const { id } = request.params as { id: string };
    const existente = await getCitaPorId(id);
    // Misma respuesta si no existe o es de otra: no se confirma que exista.
    if (!existente || !citaEsDeProfesional(existente.profesional_id, yo.profesionalId)) {
      return reply.status(404).send({ error: "cita_no_encontrada" });
    }

    const cita = await actualizarEstadoCita(id, parsed.data.estado);
    if (!cita) return reply.status(404).send({ error: "cita_no_encontrada" });

    logger.info({ citaId: id, estado: parsed.data.estado, profesionalId: yo.profesionalId }, "Cita marcada por su profesional");
    return reply.send({ cita: { id: cita.id, estado: cita.estado } });
  });

  /** Registrar una atención que llegó sin reserva, siempre a su nombre. */
  app.post("/equipo/atencion", async (request: FastifyRequest, reply: FastifyReply) => {
    const yo = await requireProfesional(request.headers.authorization);

    const parsed = atencionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    const body = parsed.data;

    const inicio = new Date(body.inicio);
    if (!inicioEnRango(inicio, new Date())) return reply.status(400).send({ error: "fuera_de_rango" });

    // Solo servicios que ella hace: el panel de recepción confía en que el
    // formulario ofrezca solo los válidos; acá no se confía en ningún formulario.
    const suyos = await serviciosDeProfesional(yo.profesionalId);
    const noPermitidos = serviciosNoPermitidos(body.servicio_ids, suyos);
    if (noPermitidos.length > 0) {
      return reply.status(400).send({ error: "servicio_no_permitido", servicio_id_fallido: noPermitidos[0] });
    }

    // Atiende en ese local (y existe, y está activa).
    const enSede = await getProfesionalEnSede(yo.profesionalId, body.sede_id);
    if (!enSede) return reply.status(400).send({ error: "profesional_no_encontrada" });

    let cliente;
    if (body.cliente_id) {
      // Solo una clienta suya: cualquier otro uuid se trata como inexistente.
      if (!(await clienteEsDeProfesional(body.cliente_id, yo.profesionalId))) {
        return reply.status(404).send({ error: "cliente_no_encontrado" });
      }
      cliente = await getClienteById(body.cliente_id);
    } else {
      const telefono = normalizarTelefono(body.telefono!);
      if (!telefono) return reply.status(400).send({ error: "telefono_invalido" });
      cliente = await findOrCreateByPhone(telefono, body.nombre);
    }
    if (!cliente) return reply.status(404).send({ error: "cliente_no_encontrado" });

    const resultado = await crearCitasConsecutivas({
      clienteId: cliente.id,
      servicioIds: body.servicio_ids,
      inicioUtc: inicio,
      creadaPor: "humano",
      profesionalId: yo.profesionalId,
      sedeId: body.sede_id,
      omitirAntelacion: true,
      estado: body.estado,
      ...(body.comentario ? { notas: body.comentario } : {}),
    });

    if (!resultado.ok) {
      logger.warn({ reason: resultado.reason, profesionalId: yo.profesionalId }, "Atención sin reserva rechazada");
      return reply.status(409).send({ error: resultado.reason, servicio_id_fallido: resultado.servicioIdFallido });
    }

    logger.info(
      { clienteId: cliente.id, cantidad: resultado.citas.length, profesionalId: yo.profesionalId },
      "Atención sin reserva registrada por su profesional",
    );
    return reply.status(201).send({
      citas: resultado.citas.map((c) => ({ id: c.id, inicio_utc: c.inicio_utc, fin_utc: c.fin_utc, estado: c.estado })),
      cliente: { id: cliente.id, nombre: cliente.nombre },
    });
  });

  /**
   * Anotar la venta de un producto. Cae en la caja ABIERTA de su local; si no
   * hay una, no se anota (409): el dinero no puede quedar sin caja donde
   * cuadrarse, y ella no tiene forma de abrirla.
   */
  app.post("/equipo/ventas", async (request: FastifyRequest, reply: FastifyReply) => {
    const yo = await requireProfesional(request.headers.authorization);

    const parsed = ventaSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    const body = parsed.data;

    const enSede = await getProfesionalEnSede(yo.profesionalId, body.sede_id);
    if (!enSede) return reply.status(400).send({ error: "profesional_no_encontrada" });

    const caja = await cajaAbiertaEnSede(body.sede_id);
    if (!caja) return reply.status(409).send({ error: "caja_cerrada" });

    const movimiento = await registrarVentaProducto({
      sesionId: caja.id,
      concepto: body.concepto,
      monto: body.monto,
      metodo: body.metodo,
      profesionalId: yo.profesionalId,
      usuarioId: yo.id,
    });

    logger.info({ movimientoId: movimiento.id, monto: body.monto, profesionalId: yo.profesionalId }, "Venta de producto anotada por su profesional");
    return reply.status(201).send({ movimiento: { id: movimiento.id, concepto: body.concepto, monto: body.monto } });
  });
}
