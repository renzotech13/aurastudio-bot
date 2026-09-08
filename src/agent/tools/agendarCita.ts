import { z } from "zod";
import type { AgentTool } from "./types.js";
import { getServiceById } from "../../db/repositories/services.js";
import { guardarEmailCliente, guardarNombreCliente } from "../../db/repositories/clientes.js";
import { crearCita } from "../../db/repositories/citas.js";
import { timeStringToUtcDate } from "../../lib/availability.js";
import { BUSINESS_TIMEZONE } from "../../config/business.js";

const FECHA_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HORA_REGEX = /^\d{2}:\d{2}$/;

const inputSchema = z.object({
  servicio_id: z.string(),
  fecha: z.string().regex(FECHA_REGEX, "Formato de fecha debe ser YYYY-MM-DD"),
  hora: z.string().regex(HORA_REGEX, "Formato de hora debe ser HH:mm"),
  nombre_cliente: z.string().optional(),
  correo_cliente: z.string().email().optional(),
});

export const agendarCitaTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "agendar_cita",
  description:
    "Agenda una cita. fecha y hora deben ser exactamente un valor que devolvió consultar_disponibilidad para ese " +
    "servicio — nunca inventes ni calcules un horario. nombre_cliente es opcional: solo pídelo si no lo tienes " +
    "ya del contexto de la conversación. correo_cliente es opcional: si la clienta lo da (por ejemplo porque " +
    "quiere la invitación en su Google Calendar), pásalo aquí; nunca lo pidas como requisito para agendar.",
  inputSchema,
  mutates: true,
  jsonSchema: {
    type: "object",
    properties: {
      servicio_id: { type: "string" },
      fecha: { type: "string", description: "YYYY-MM-DD, debe venir de consultar_disponibilidad" },
      hora: { type: "string", description: "HH:mm hora de Lima, debe venir de consultar_disponibilidad" },
      nombre_cliente: { type: "string", description: "Solo si no está ya disponible del contexto" },
      correo_cliente: { type: "string", description: "Opcional, solo si la clienta lo ofrece voluntariamente" },
    },
    required: ["servicio_id", "fecha", "hora"],
  },
  handler: async (input, ctx) => {
    // Un lead de Instagram/Messenger sin teléfono todavía no puede agendar:
    // la cita necesita un número real al que avisarle. Usa
    // guardar_datos_contacto para resolver esto sin salir del canal.
    if (!ctx.telefono) {
      return {
        ok: false,
        error: "sin_telefono",
        instruccion: "Pide a la clienta su número de WhatsApp (9 dígitos, Perú) y regístralo con guardar_datos_contacto antes de continuar.",
      };
    }

    const servicio = await getServiceById(input.servicio_id);
    if (!servicio || !servicio.duration_minutes) {
      return { ok: false, error: "servicio_no_encontrado" };
    }

    // ctx.clienteId ya viene resuelto (por teléfono en WhatsApp, por
    // identidad en Messenger/Instagram) — no hace falta volver a buscar por
    // teléfono acá.
    if (input.nombre_cliente) await guardarNombreCliente(ctx.clienteId, input.nombre_cliente).catch(() => {});
    if (input.correo_cliente) await guardarEmailCliente(ctx.clienteId, input.correo_cliente).catch(() => {});

    const inicioUtc = timeStringToUtcDate(input.fecha, input.hora, BUSINESS_TIMEZONE);
    const finUtc = new Date(inicioUtc.getTime() + servicio.duration_minutes * 60_000);

    const result = await crearCita({
      clienteId: ctx.clienteId,
      servicioId: servicio.id,
      inicioUtc,
      finUtc,
      creadaPor: "bot",
    });

    if (!result.ok) {
      return { ok: false, error: result.reason };
    }

    return {
      ok: true,
      cita_id: result.cita.id,
      servicio: servicio.name,
      fecha: input.fecha,
      hora: input.hora,
      precio: `S/ ${servicio.price}`,
      adelanto: servicio.deposit_amount != null ? `S/ ${servicio.deposit_amount}` : "se coordina por WhatsApp",
    };
  },
};
