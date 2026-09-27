import { z } from "zod";

/**
 * Reglas de lo que una profesional puede hacer desde su app.
 *
 * Están acá, sin base de datos ni HTTP, para poder probarlas una por una: son
 * las que separan "una profesional anotando lo suyo" de "una profesional
 * tocando la caja o las citas de otra". La ruta (routes/equipo.ts) solo
 * consulta datos y aplica estas reglas.
 */

/** Los mismos valores que el enum `metodo_pago` de Postgres (migración 0009). */
export const METODOS_PAGO = ["efectivo", "yape", "plin", "tarjeta", "transferencia", "otro"] as const;
export type MetodoPago = (typeof METODOS_PAGO)[number];

/**
 * Tope de una venta anotada por una profesional. No es un control de fraude
 * (quien tenga la caja abierta ve el movimiento y puede anularlo): es para
 * que un dedo de más —S/ 4500 en vez de S/ 45— no llegue a la caja.
 */
export const MAX_VENTA_SOLES = 1500;

/**
 * Ventana en la que una profesional puede anotar una atención sin reserva:
 * lo que acaba de pasar o está por pasar. No es una agenda abierta — anotar
 * atenciones de hace un mes es cosa de recepción, con la caja a la vista.
 */
export const HORAS_ATRAS = 48;
export const HORAS_ADELANTE = 24;

export function inicioEnRango(inicio: Date, ahora: Date): boolean {
  const t = inicio.getTime();
  if (Number.isNaN(t)) return false;
  return t >= ahora.getTime() - HORAS_ATRAS * 3_600_000 && t <= ahora.getTime() + HORAS_ADELANTE * 3_600_000;
}

/** Los servicios pedidos que la profesional NO hace. Vacío = todos permitidos. */
export function serviciosNoPermitidos(pedidos: readonly string[], suyos: ReadonlySet<string>): string[] {
  return pedidos.filter((id) => !suyos.has(id));
}

/**
 * ¿Esta cita es de esta profesional? Una cita sin profesional asignada
 * (`null`, las que entraron antes de la 0014) no es de nadie: ninguna
 * profesional puede tocarla.
 */
export function citaEsDeProfesional(citaProfesionalId: string | null | undefined, profesionalId: string): boolean {
  return typeof citaProfesionalId === "string" && citaProfesionalId === profesionalId;
}

// ─── Cuerpos de las tres acciones ───────────────────────────────────────────

/** Marcar una cita suya. Los mismos cuatro estados que el panel de recepción. */
export const estadoSchema = z.object({
  estado: z.enum(["confirmada", "cancelada", "completada", "no_asistio"]),
});

/**
 * Atención sin reserva. Sin `profesional_id` a propósito: siempre es ella, y
 * aceptarlo del cuerpo sería aceptar que anote a nombre de otra.
 */
export const atencionSchema = z
  .object({
    // Una de las dos: una clienta suya, o una nueva con teléfono y nombre.
    cliente_id: z.string().uuid().optional(),
    telefono: z.string().trim().min(6).max(30).optional(),
    nombre: z.string().trim().min(2).max(120).optional(),
    servicio_ids: z.array(z.string().min(1)).min(1).max(10),
    sede_id: z.string().min(1),
    inicio: z.string().datetime({ offset: true }),
    estado: z.enum(["confirmada", "completada"]).default("completada"),
    comentario: z.string().trim().max(1000).optional(),
  })
  .refine((d) => Boolean(d.cliente_id) || (Boolean(d.telefono) && Boolean(d.nombre)), {
    message: "Manda cliente_id, o telefono y nombre para crearla",
  });

/** Anotar la venta de un producto. Siempre ingreso, siempre categoría producto. */
export const ventaSchema = z.object({
  sede_id: z.string().min(1),
  concepto: z.string().trim().min(2).max(120),
  monto: z.number().positive().max(MAX_VENTA_SOLES),
  metodo: z.enum(METODOS_PAGO).default("efectivo"),
});
