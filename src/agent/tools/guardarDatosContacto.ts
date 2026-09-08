import { z } from "zod";
import type { AgentTool } from "./types.js";
import { normalizarTelefono } from "../../lib/telefono.js";
import {
  getClienteByTelefono,
  guardarTelefonoCliente,
  guardarNombreCliente,
  guardarEmailCliente,
  fusionarClientes,
} from "../../db/repositories/clientes.js";
import { registrarEvento } from "../../db/repositories/eventos.js";

const inputSchema = z.object({
  telefono: z.string().optional(),
  nombre: z.string().optional(),
  email: z.string().email().optional(),
});

/**
 * Así es como un lead de Instagram/Messenger termina agendando sin salir
 * del canal: el modelo la llama cuando la clienta da su número, y las tools
 * de citas (que exigían teléfono) empiezan a funcionar en el mismo turno.
 */
export const guardarDatosContactoTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "guardar_datos_contacto",
  description:
    "Guarda el número de WhatsApp, nombre o correo de la clienta cuando los da voluntariamente por Instagram o " +
    "Messenger. Llámala antes de reintentar agendar_cita, consultar_mis_citas, reagendar_cita o cancelar_cita si " +
    "cualquiera de esas te devolvió error 'sin_telefono'. El teléfono debe ser el número peruano de WhatsApp " +
    "(9 dígitos, con o sin el 51 delante) — nunca inventes uno.",
  inputSchema,
  mutates: true,
  jsonSchema: {
    type: "object",
    properties: {
      telefono: { type: "string", description: "Número de WhatsApp de la clienta (Perú)" },
      nombre: { type: "string" },
      email: { type: "string" },
    },
  },
  handler: async (input, ctx) => {
    if (!input.telefono && !input.nombre && !input.email) {
      return { ok: false, error: "sin_datos" };
    }

    if (input.telefono) {
      const normalizado = normalizarTelefono(input.telefono);
      if (!normalizado) {
        return { ok: false, error: "telefono_invalido", instruccion: "Pídele el número de nuevo, parece incompleto." };
      }

      const existente = await getClienteByTelefono(normalizado);
      if (existente && existente.id !== ctx.clienteId) {
        // Ya escribió antes por WhatsApp con este mismo número: en vez de
        // rechazar, se fusionan las dos fichas — la del lead (sin teléfono)
        // desaparece dentro de la que ya tenía historial real.
        await fusionarClientes(ctx.clienteId, existente.id);
        await registrarEvento(ctx.conversacionId, "fusion", { origen: ctx.clienteId, destino: existente.id }).catch(() => {});
        ctx.clienteId = existente.id;
        ctx.telefono = normalizado;
      } else {
        await guardarTelefonoCliente(ctx.clienteId, normalizado);
        ctx.telefono = normalizado;
      }
    }

    // Nombre y correo se aplican sobre el destino FINAL — si hubo fusión,
    // ctx.clienteId ya apunta a la clienta que sobrevivió.
    if (input.nombre) await guardarNombreCliente(ctx.clienteId, input.nombre).catch(() => {});
    if (input.email) await guardarEmailCliente(ctx.clienteId, input.email).catch(() => {});

    return { ok: true };
  },
};
