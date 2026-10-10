import { z } from "zod";
import type { AgentContext, AgentTool } from "./types.js";
import { listActiveServices, getServiceById, type Service } from "../../db/repositories/services.js";
import { listActiveCategories } from "../../db/repositories/categorias.js";
import { guardarMensaje } from "../../db/repositories/mensajes.js";
import { consultarDisponibilidadReal } from "../../lib/disponibilidadService.js";
import { BUSINESS_TIMEZONE } from "../../config/business.js";
import { sendButtons, sendList, sendTarjeta, sendText } from "../../whatsapp/client.js";
import { elegirHorarios, esImagenCompatible, etiquetaHorario, filaServicio, resumenServicio, type FilaLista } from "../../whatsapp/formato.js";

/**
 * Mensajes interactivos de WhatsApp para que la clienta reserve tocando, no leyendo listas largas:
 * - mostrar_servicios: una lista desplegable (hasta 10) o, para 1 a 3 recomendados, tarjetas con foto y botón "Reservar".
 * - ofrecer_horarios: los horarios REALES libres como lista para tocar (los calcula aquí, no el modelo).
 * - preguntar_con_botones: una pregunta con 2 o 3 botones (sede, confirmar, otro horario…).
 * Lo que la clienta toca vuelve como texto con su id (ver handleMessage.ts: "(Tocó la opción … · servicio:<id>)").
 * Solo WhatsApp: en Messenger/Instagram devuelven canal_no_soportado y el bot escribe máximo 3 opciones.
 */

const NO_SOPORTADO = {
  ok: false,
  error: "canal_no_soportado",
  instruccion: "Por este canal no hay botones ni listas: escribe como máximo 3 opciones cortas y una pregunta.",
};

function soloWhatsapp(ctx: AgentContext): string | null {
  return ctx.canal === "whatsapp" && ctx.telefono ? ctx.telefono : null;
}

function hoyLima(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
}

const mostrarSchema = z.object({
  texto: z.string().min(1).max(600),
  servicio_ids: z.array(z.string()).min(1).max(10).optional(),
  categoria_id: z.string().optional(),
  formato: z.enum(["lista", "tarjetas"]).optional(),
});

export const mostrarServiciosTool: AgentTool<z.infer<typeof mostrarSchema>> = {
  name: "mostrar_servicios",
  description:
    "WhatsApp: muestra servicios para que la clienta elija tocando, en vez de escribir el catálogo. Pasa servicio_ids " +
    "(máx. 10) o categoria_id. formato 'tarjetas' (1 a 3 recomendados: foto, precio y botón Reservar) o 'lista' " +
    "(desplegable de hasta 10). `texto` es la frase corta de arriba (sin repetir precios). Después NO escribas la lista " +
    "en tu respuesta: tu respuesta final queda vacía o en una frase.",
  inputSchema: mostrarSchema,
  mutates: true,
  jsonSchema: {
    type: "object",
    properties: {
      texto: { type: "string", description: "Frase corta arriba de las opciones, p. ej. '¡Sí, hoy tenemos espacio! 💅 ¿Cuál te gustaría?'" },
      servicio_ids: { type: "array", items: { type: "string" }, description: "Ids del CATÁLOGO, en el orden a mostrar" },
      categoria_id: { type: "string", description: "Id de categoría del CATÁLOGO (si no pasas servicio_ids)" },
      formato: { type: "string", enum: ["lista", "tarjetas"] },
    },
    required: ["texto"],
  },
  handler: async (input, ctx) => {
    const telefono = soloWhatsapp(ctx);
    if (!telefono) return NO_SOPORTADO;

    const [servicios, categorias] = await Promise.all([listActiveServices(), listActiveCategories()]);
    const elegidos = input.servicio_ids
      ? input.servicio_ids.map((id) => servicios.find((s) => s.id === id)).filter((s): s is Service => Boolean(s))
      : servicios.filter((s) => s.category_id === input.categoria_id);
    if (elegidos.length === 0) return { ok: false, error: "sin_servicios", instruccion: "Revisa los ids del CATÁLOGO." };

    const tarjetas = input.formato === "tarjetas" || (!input.formato && elegidos.length <= 3);
    let waId: string;
    let resumen: string;
    if (tarjetas) {
      const top = elegidos.slice(0, 3);
      await sendText(telefono, input.texto);
      let ultimo = "";
      for (const s of top) {
        const foto = categorias.find((c) => c.id === s.category_id)?.images.find((u) => esImagenCompatible(u)) ?? null;
        const desc = s.description ? `\n${s.description.split(/(?<=\.)\s/)[0]}` : "";
        ultimo = await sendTarjeta({
          to: telefono,
          imagenUrl: foto,
          cuerpo: `*${s.name}*\n${resumenServicio(s)}${desc}`,
          botones: [{ id: `reservar:${s.id}`, title: "Reservar" }],
        });
      }
      waId = ultimo;
      resumen = `${input.texto}\n${top.map((s) => `[Tarjeta] ${s.name} · ${resumenServicio(s)} · botón Reservar`).join("\n")}`;
    } else {
      const top = elegidos.slice(0, 10);
      waId = await sendList({ to: telefono, cuerpo: input.texto, boton: "Ver opciones", secciones: [{ filas: top.map(filaServicio) }] });
      resumen = `${input.texto}\n[Lista] ${top.map((s) => `${s.name} (${resumenServicio(s)})`).join(" · ")}`;
    }

    await guardarMensaje({ conversacionId: ctx.conversacionId, rol: "assistant", contenido: resumen, waMessageId: waId });
    ctx.interactivoEnviado = true;
    return { ok: true, mostrados: elegidos.slice(0, tarjetas ? 3 : 10).map((s) => s.name), formato: tarjetas ? "tarjetas" : "lista" };
  },
};

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const horariosSchema = z.object({
  servicio_id: z.string(),
  fecha_desde: z.string().regex(FECHA),
  fecha_hasta: z.string().regex(FECHA).optional(),
  texto: z.string().min(1).max(400),
  sede: z.string().max(40).optional(),
});

export const ofrecerHorariosTool: AgentTool<z.infer<typeof horariosSchema>> = {
  name: "ofrecer_horarios",
  description:
    "WhatsApp: consulta la disponibilidad REAL de un servicio y le manda los horarios libres como lista para tocar " +
    "(hasta 9, repartidos en los primeros días con espacio). Úsala en vez de escribir horarios. Si devuelve " +
    "sin_horarios, dile que en esas fechas no hay y prueba un rango más amplio. Al tocar uno, llega 'horario:<servicio>:<fecha>:<hora>'.",
  inputSchema: horariosSchema,
  mutates: true,
  jsonSchema: {
    type: "object",
    properties: {
      servicio_id: { type: "string" },
      fecha_desde: { type: "string", description: "YYYY-MM-DD" },
      fecha_hasta: { type: "string", description: "YYYY-MM-DD (opcional; usa +6 días para tener alternativas)" },
      texto: { type: "string", description: "Frase corta arriba, p. ej. 'Estos son los horarios libres para tus uñas builder:'" },
      sede: { type: "string", description: "Sede elegida, si ya la sabes (va en la descripción de cada horario)" },
    },
    required: ["servicio_id", "fecha_desde", "texto"],
  },
  handler: async (input, ctx) => {
    const telefono = soloWhatsapp(ctx);
    if (!telefono) return NO_SOPORTADO;
    const servicio = await getServiceById(input.servicio_id);
    if (!servicio?.duration_minutes) return { ok: false, error: "servicio_no_encontrado" };

    const dias = await consultarDisponibilidadReal({
      duracionMinutos: servicio.duration_minutes,
      fechaDesde: input.fecha_desde,
      fechaHasta: input.fecha_hasta ?? input.fecha_desde,
    });
    const horarios = elegirHorarios(dias);
    if (horarios.length === 0) return { ok: false, error: "sin_horarios" };

    const hoy = hoyLima();
    const filas: FilaLista[] = horarios.map((h) => ({
      id: `horario:${servicio.id}:${h.fecha}:${h.hora}`,
      titulo: etiquetaHorario(h.fecha, h.hora, hoy),
      descripcion: [servicio.name, input.sede].filter(Boolean).join(" · "),
    }));
    const waId = await sendList({ to: telefono, cuerpo: input.texto, boton: "Ver horarios", secciones: [{ filas }] });
    await guardarMensaje({
      conversacionId: ctx.conversacionId,
      rol: "assistant",
      contenido: `${input.texto}\n[Horarios] ${filas.map((f) => f.titulo).join(" · ")}`,
      waMessageId: waId,
    });
    ctx.interactivoEnviado = true;
    return { ok: true, ofrecidos: horarios };
  },
};

const botonesSchema = z.object({
  texto: z.string().min(1).max(600),
  opciones: z.array(z.string().min(1).max(20)).min(2).max(3),
});

export const preguntarConBotonesTool: AgentTool<z.infer<typeof botonesSchema>> = {
  name: "preguntar_con_botones",
  description:
    "WhatsApp: manda tu pregunta con 2 o 3 botones (máx. 20 caracteres cada uno) para que responda con un toque: " +
    "elegir sede, confirmar la cita (['Confirmar', 'Otro horario']), sí/no. Después tu respuesta final queda vacía.",
  inputSchema: botonesSchema,
  mutates: true,
  jsonSchema: {
    type: "object",
    properties: {
      texto: { type: "string" },
      opciones: { type: "array", items: { type: "string" }, description: "2 o 3 textos cortos (máx. 20 caracteres)" },
    },
    required: ["texto", "opciones"],
  },
  handler: async (input, ctx) => {
    const telefono = soloWhatsapp(ctx);
    if (!telefono) return NO_SOPORTADO;
    const waId = await sendButtons(
      telefono,
      input.texto,
      input.opciones.map((o, i) => ({ id: `opcion:${i + 1}`, title: o })),
    );
    await guardarMensaje({
      conversacionId: ctx.conversacionId,
      rol: "assistant",
      contenido: `${input.texto}\n[Botones] ${input.opciones.join(" | ")}`,
      waMessageId: waId,
    });
    ctx.interactivoEnviado = true;
    return { ok: true };
  },
};
