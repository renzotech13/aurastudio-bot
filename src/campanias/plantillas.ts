/**
 * Plantillas de WhatsApp de las campañas de Aura, definidas en código (como en B&B): el panel las muestra con su estado
 * en Meta, las manda a aprobar con un botón y envía por lotes a la audiencia de cada una. Para una campaña nueva se
 * agrega una entrada aquí; nadie tiene que copiar textos a mano en el Administrador de WhatsApp.
 *
 * Reglas de Meta que estos textos respetan: nombre en minúsculas con guiones bajos, ninguna {{n}} al principio ni al
 * final del cuerpo, un ejemplo por variable, botones de máximo 25 caracteres.
 */

/** A quién le llega: `automatica` = la manda el bot sola (no hay envío por lote). */
export type TipoAudiencia = "automatica" | "clientas" | "leads" | "todas";

export type DefinicionPlantilla = {
  clave: string;
  nombre: string;
  titulo: string;
  /** Para qué sirve y cuándo mandarla, en una frase para el panel. */
  descripcion: string;
  categoria: "UTILITY" | "MARKETING";
  cuerpo: string;
  ejemplos: string[];
  pie?: string;
  botones: string[];
  audiencia: TipoAudiencia;
  /** Desde qué día cuentan los leads y las reservas de la campaña (YYYY-MM-DD, hora de Lima). */
  campanaDesde?: string;
  /** Ventana en la que se permite el envío por lote (YYYY-MM-DD, hora de Lima, ambos incluidos). */
  enviarDesde?: string;
  enviarHasta?: string;
};

/** Texto exacto de los botones de baja: quien lo toca no vuelve a recibir campañas. */
export const BOTON_BAJA = "Detener promociones";
export const FRASES_BAJA = [BOTON_BAJA, "No quiero más mensajes", "No quiero más promos"];

const BOTONES_PROMO = ["Quiero reservar", "Más adelante", BOTON_BAJA];
const PIE_AURA = "Aura Studio · Los Olivos e Independencia";

export const PLANTILLAS_CAMPANIA: DefinicionPlantilla[] = [
  {
    clave: "recordatorio",
    nombre: "recordatorio_cita",
    titulo: "Recordatorio de cita",
    descripcion:
      "La manda el bot sola unas horas antes de cada cita cuando la clienta no escribió en las últimas 24 h. Sin esta plantilla aprobada, esos recordatorios no salen.",
    categoria: "UTILITY",
    // Mismo texto y mismas 3 variables que usa notifications/recordatorios.ts (nombre, servicio, cuándo).
    cuerpo:
      "Hola {{1}} 💕 Te recordamos tu cita de {{2}} el {{3}} en Aura Studio. Si necesitas reagendar o cancelar, respóndenos por acá.",
    ejemplos: ["Lucía", "Pestañas 1x1", "sábado 17 de octubre a las 11:00 a. m."],
    botones: [],
    audiencia: "automatica",
  },
  {
    clave: "halloween-promo",
    nombre: "aura_halloween_promo",
    titulo: "Halloween · anuncio a clientas",
    descripcion: "Para avisarle de la promo a las clientas que ya tienen su WhatsApp en la base.",
    categoria: "MARKETING",
    cuerpo:
      "Hola {{1}} 🎃 Este Halloween en Aura Studio, por cada servicio de salón te llevas pestañas 1x1 a S/ 20, con el efecto que quieras: natural, rímel o volumen.\n\nDel 12 al 23 de octubre en Los Olivos e Independencia. Un bono por clienta por día.\n\n¿Te separo tu cita?",
    ejemplos: ["Lucía"],
    pie: PIE_AURA,
    botones: BOTONES_PROMO,
    audiencia: "clientas",
    campanaDesde: "2026-10-08",
    enviarDesde: "2026-10-08",
    enviarHasta: "2026-10-22",
  },
  {
    clave: "halloween-seguimiento",
    nombre: "aura_halloween_seguimiento",
    titulo: "Halloween · seguimiento a quien escribió",
    descripcion:
      "Para quien escribió desde que empezó la campaña y todavía no reservó, una vez que pasó su conversación (más de 20 h sin escribir).",
    categoria: "MARKETING",
    cuerpo:
      "Hola {{1}} 👋 Te escribo de Aura Studio por las pestañas 1x1 a S/ 20 de Halloween. Todavía hay horarios del 12 al 23 de octubre en Los Olivos e Independencia, junto con el servicio de salón que elijas.\n\n¿Te ayudo a separar tu cita?",
    ejemplos: ["Lucía"],
    pie: PIE_AURA,
    botones: BOTONES_PROMO,
    audiencia: "leads",
    campanaDesde: "2026-10-08",
    enviarDesde: "2026-10-09",
    enviarHasta: "2026-10-22",
  },
  {
    clave: "halloween-ultimos-dias",
    nombre: "aura_halloween_ultimos_dias",
    titulo: "Halloween · últimos días",
    descripcion: "Del 20 al 23 de octubre, a clientas y leads que todavía no reservaron en la campaña.",
    categoria: "MARKETING",
    cuerpo:
      "Hola {{1}} ⏳ Quedan pocos días de Halloween en Aura Studio: pestañas 1x1 a S/ 20 con cualquier servicio de salón, solo hasta el 23 de octubre en Los Olivos e Independencia.\n\n¿Te separo un horario antes de que se acabe?",
    ejemplos: ["Lucía"],
    pie: PIE_AURA,
    botones: BOTONES_PROMO,
    audiencia: "todas",
    campanaDesde: "2026-10-08",
    enviarDesde: "2026-10-20",
    enviarHasta: "2026-10-23",
  },
];

export function plantillaPorClave(clave: string): DefinicionPlantilla | undefined {
  return PLANTILLAS_CAMPANIA.find((p) => p.clave === clave);
}

/** Primer nombre para el saludo; los nombres de perfil raros ("✨ la más linda ✨") no van, y entonces se usa «bella». */
export function nombreSaludo(nombre: string | null | undefined): string {
  const n = (nombre ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-zÁÉÍÓÚÑáéíóúñü]{2,}$/.test(n) ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : "bella";
}

/** El cuerpo tal como lo lee la clienta: así queda guardado en su chat del panel. */
export function cuerpoPara(def: DefinicionPlantilla, parametros: string[]): string {
  return def.cuerpo.replace(/\{\{(\d+)\}\}/g, (_, n: string) => parametros[Number(n) - 1] ?? "");
}

/** Hoy en Lima (YYYY-MM-DD). Lima no tiene horario de verano: siempre UTC-5. */
export function hoyLima(ahora = new Date()): string {
  return new Date(ahora.getTime() - 5 * 60 * 60_000).toISOString().slice(0, 10);
}

/** null si hoy se puede mandar el lote; si no, el motivo para mostrarlo en el panel. */
export function fueraDeFecha(def: DefinicionPlantilla, ahora = new Date()): string | null {
  const hoy = hoyLima(ahora);
  if (def.enviarDesde && hoy < def.enviarDesde) return `Se puede mandar desde el ${fechaLarga(def.enviarDesde)}.`;
  if (def.enviarHasta && hoy > def.enviarHasta) return `Su fecha pasó: era hasta el ${fechaLarga(def.enviarHasta)}.`;
  return null;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
function fechaLarga(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} de ${MESES[(m ?? 1) - 1]}`;
}
