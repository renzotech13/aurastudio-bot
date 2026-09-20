/**
 * Guías gratuitas que Aura comparte cuando alguien escribe la palabra clave del
 * final de un video ("Escríbeme BALAYAGE y te mando la guía").
 *
 * Cada guía es una página pública de aurastudio.pe (web/guias/*.html): un solo
 * enlace sirve igual en Instagram, Messenger y WhatsApp, y no depende de poder
 * mandar archivos (eso solo sale por WhatsApp).
 *
 * Para sumar una guía: publicar su página en el sitio y agregarla acá. El
 * comentario y el agente la reconocen sin tocar nada más.
 */
export interface Guia {
  /** Palabra que se pide en el video, tal como se lee en pantalla. */
  clave: string;
  /** Otras formas de escribirla que también cuentan (se comparan sin tildes ni mayúsculas). */
  alias: string[];
  /** Cómo se nombra dentro del mensaje: "Aquí tienes tu <nombre>: ...". */
  nombre: string;
  url: string;
  /** Frase que invita a seguir la conversación (lleva a la reserva). */
  cierre: string;
}

export const GUIAS: readonly Guia[] = [
  {
    clave: "BALAYAGE",
    alias: [],
    nombre: "guía de balayage paso a paso",
    url: "https://aurastudio.pe/guias/balayage",
    cierre: "Cuando la revises, cuéntame qué tono imaginas y te ayudo a agendar tu evaluación.",
  },
];

/**
 * Un comentario más largo que esto ya es conversación ("qué lindo quedó el
 * balayage, ¿cuánto dura?"), no alguien pidiendo la guía: no se le gasta la
 * única respuesta privada que Meta permite por comentario.
 */
export const MAX_PALABRAS_COMENTARIO_CLAVE = 6;

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * ¿El comentario pide una guía? Compara por palabra completa (no por trozo),
 * así "balayages" o "imbalayage" no cuentan. Devuelve null si no pide ninguna.
 */
export function buscarGuia(texto: string): Guia | null {
  const palabras = normalizar(texto).match(/[a-z0-9]+/g) ?? [];
  if (palabras.length === 0 || palabras.length > MAX_PALABRAS_COMENTARIO_CLAVE) return null;
  for (const guia of GUIAS) {
    const claves = [guia.clave, ...guia.alias].map(normalizar);
    if (palabras.some((p) => claves.includes(p))) return guia;
  }
  return null;
}

/** El mensaje privado que recibe quien pidió la guía. */
export function mensajeGuia(guia: Guia): string {
  return `¡Hola! 🤎 Aquí tienes tu ${guia.nombre}: ${guia.url}\n\n${guia.cierre}`;
}
