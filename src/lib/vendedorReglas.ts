/**
 * Lo que un vendedor puede y no puede hacer con las reservas.
 *
 * Un vendedor agenda y cancela, pero no registra lo que pasó en el salón:
 * marcar una atención como «completada» o a una clienta como «no vino» es el
 * registro de lo que ocurrió (alimenta las métricas y la caja), y eso lo hace
 * la profesional o la administradora. Reglas puras, sin base de datos, para
 * poder probarlas aparte.
 */

export type RolAtencion = "staff" | "vendedor";
export type EstadoCita = "confirmada" | "cancelada" | "completada" | "no_asistio";

const ESTADOS_DEL_VENDEDOR: readonly EstadoCita[] = ["confirmada", "cancelada"];

/** ¿Puede este rol dejar la cita en este estado? */
export function estadoPermitido(rol: RolAtencion, estado: EstadoCita): boolean {
  return rol === "staff" || ESTADOS_DEL_VENDEDOR.includes(estado);
}

/**
 * Estado con el que nace una cita creada desde el panel. Para la administradora
 * es lo que ella pidió (por defecto «completada», porque lo suyo es anotar lo
 * que acaba de pasar); un vendedor siempre crea una reserva «confirmada».
 */
export function estadoDeNuevaCita(rol: RolAtencion, pedido: "confirmada" | "completada"): "confirmada" | "completada" {
  return rol === "vendedor" ? "confirmada" : pedido;
}

/** Margen para que «ahora» no falle por unos minutos de reloj o de tipeo. */
const TOLERANCIA_PASADO_MS = 15 * 60_000;

/**
 * Un vendedor reserva a futuro. Una cita en el pasado es una atención que ya
 * ocurrió, y anotarla es cosa de recepción.
 */
export function inicioPermitido(rol: RolAtencion, inicio: Date, ahora: Date): boolean {
  return rol === "staff" || inicio.getTime() >= ahora.getTime() - TOLERANCIA_PASADO_MS;
}
