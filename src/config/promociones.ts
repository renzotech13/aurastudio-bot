/**
 * Promociones vigentes que el bot SÍ puede ofrecer (la regla general sigue siendo no inventar descuentos).
 * Cada una tiene fechas: el bot la menciona desde `anunciarDesde` (cuando arrancan los anuncios, como preventa)
 * y la aplica de `desde` a `hasta` (hora de Lima). Pasada la fecha, desaparece sola del prompt.
 *
 * Para sumar una promo: agregarla acá con sus fechas y reglas exactas (las mismas del anuncio). Nada más.
 */
export interface Promocion {
  clave: string;
  nombre: string;
  /** Desde cuándo el bot puede contarla (YYYY-MM-DD, Lima). Antes de `desde` se ofrece como reserva anticipada. */
  anunciarDesde: string;
  /** Primer y último día en que se aplica (YYYY-MM-DD, Lima, inclusive). */
  desde: string;
  hasta: string;
  /** La oferta en una línea, igual que en el anuncio. */
  oferta: string;
  /** Condiciones que el bot debe respetar al pie de la letra. */
  reglas: string[];
  /** Palabras del anuncio que la identifican cuando la clienta llega desde él. */
  pistas: string[];
}

export const PROMOCIONES: readonly Promocion[] = [
  {
    clave: "halloween-2026",
    nombre: "Halloween · pestañas 1x1 a S/ 20",
    anunciarDesde: "2026-10-08",
    desde: "2026-10-12",
    hasta: "2026-10-23",
    oferta:
      "Por cada servicio de salón (aplican todos), la clienta se lleva pestañas 1x1 a S/ 20 con cualquier efecto (natural, rímel o volumen).",
    reglas: [
      "1 bono por clienta por día, aunque haga 2 servicios ese mismo día.",
      "Vale en las dos sedes: Los Olivos e Independencia.",
      "Las pestañas a S/ 20 van junto con un servicio de salón ese mismo día; solas no tienen ese precio.",
      "Se agenda como dos servicios: el servicio de salón que elija + las pestañas 1x1 (el precio de S/ 20 lo aplica el salón).",
    ],
    pistas: ["truco o trato", "halloween", "pestañas 1x1", "s/20", "s/ 20", "doce días", "da miedo"],
  },
];

/** "YYYY-MM-DD" de hoy en Lima. */
function hoyLima(ahora: Date): string {
  return ahora.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
}

/** Las promos que el bot puede mencionar hoy (desde `anunciarDesde` hasta `hasta`). */
export function promocionesVigentes(ahora = new Date()): Promocion[] {
  const hoy = hoyLima(ahora);
  return PROMOCIONES.filter((p) => p.anunciarDesde <= hoy && hoy <= p.hasta);
}

/** Texto para el prompt: cada promo con su estado de hoy (ya rige o es reserva anticipada). */
export function textoPromociones(ahora = new Date()): string {
  const hoy = hoyLima(ahora);
  const lista = promocionesVigentes(ahora);
  if (lista.length === 0) return "  (ninguna por ahora — no ofrezcas descuentos)";
  return lista
    .map((p) => {
      const estado =
        hoy < p.desde
          ? `Todavía NO rige (empieza el ${p.desde}): hoy se ofrece como reserva anticipada para una fecha entre el ${p.desde} y el ${p.hasta}.`
          : `Rige hoy (hasta el ${p.hasta}).`;
      return [`  - ${p.nombre}. ${p.oferta}`, `    ${estado}`, ...p.reglas.map((r) => `    · ${r}`)].join("\n");
    })
    .join("\n");
}
