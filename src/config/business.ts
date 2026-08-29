import { env } from "./env.js";

// No hay panel admin para editar estos valores todavía, así que viven como
// constantes en vez de una tabla de configuración sin UI.
//
// PROVISIONAL: heredados de Raabta/Cieza Barber, donde llevan meses en
// producción. Aura Studio todavía no los ha confirmado. Revisar antes de
// abrir reservas al público — SLOT_STEP_MINUTES=30 en particular desperdicia
// hueco con los servicios cortos de Aura (visajismo y depilación de bozo/ceja
// duran 15 min según su carta de Yocale).
export const BUFFER_MINUTES = 15;
export const MIN_LEAD_MINUTES = 120;
export const SLOT_STEP_MINUTES = 30;

export const BUSINESS_TIMEZONE = env.BUSINESS_TIMEZONE;
