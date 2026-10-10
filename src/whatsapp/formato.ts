/**
 * Formato de los mensajes interactivos de WhatsApp (listas, tarjetas, horarios). Sin dependencias a propósito:
 * son funciones puras y se prueban solas.
 */

/** Límites de WhatsApp para mensajes interactivos (si se pasan, Meta rechaza el envío). */
export const LIMITES_WA = { filaTitulo: 24, filaDescripcion: 72, botonLista: 20, botonRespuesta: 20, cuerpo: 1024, filas: 10 } as const;

/** Corta al máximo de WhatsApp con "…". Títulos y botones van en una línea; los cuerpos conservan sus saltos. */
export function recortar(texto: string, max: number, unaLinea = true): string {
  const t = unaLinea ? texto.trim().replace(/\s+/g, " ") : texto.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export type FilaLista = { id: string; titulo: string; descripcion?: string };

/** WhatsApp solo acepta JPG o PNG como foto de cabecera; un .webp hace fallar todo el mensaje. */
export function esImagenCompatible(url: string | null | undefined): url is string {
  return Boolean(url && /^https:\/\/.+\.(jpe?g|png)(\?.*)?$/i.test(url));
}

type ServicioBasico = { id: string; name: string; duration: string; price: string };

/** "1 h · S/ 65" — lo que va debajo del nombre en la lista. */
export function resumenServicio(s: Pick<ServicioBasico, "duration" | "price">): string {
  return `${s.duration} · S/ ${s.price}`;
}

export function filaServicio(s: ServicioBasico): FilaLista {
  return { id: `servicio:${s.id}`, titulo: s.name, descripcion: resumenServicio(s) };
}

const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "15:00" → "3:00 p. m." */
export function horaAmPm(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const sufijo = (h ?? 0) < 12 ? "a. m." : "p. m.";
  const h12 = (h ?? 0) % 12 === 0 ? 12 : (h ?? 0) % 12;
  return `${h12}:${String(m ?? 0).padStart(2, "0")} ${sufijo}`;
}

/** "Hoy 3:00 p. m.", "Mañana 11:00 a. m." o "Sáb 18 oct 11:00 a. m." (máx. 24 caracteres, el título de la fila). */
export function etiquetaHorario(fecha: string, hora: string, hoy: string): string {
  const manana = new Date(`${hoy}T12:00:00Z`);
  manana.setUTCDate(manana.getUTCDate() + 1);
  const d = new Date(`${fecha}T12:00:00Z`);
  const dia = fecha === hoy ? "Hoy" : fecha === manana.toISOString().slice(0, 10) ? "Mañana" : `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
  return `${dia} ${horaAmPm(hora)}`;
}

/** Hasta `max` horarios repartidos en los primeros días con espacio (no 10 seguidos del mismo día). */
export function elegirHorarios(dias: { fecha: string; horas: string[] }[], max = 9, porDia = 4): { fecha: string; hora: string }[] {
  const out: { fecha: string; hora: string }[] = [];
  for (const d of dias) {
    if (d.horas.length === 0) continue;
    // Repartidos a lo largo del día: primera, alguna de en medio y la última.
    const paso = Math.max(1, Math.floor(d.horas.length / porDia));
    const elegidas = d.horas.filter((_, i) => i % paso === 0).slice(0, porDia);
    for (const hora of elegidas) {
      if (out.length >= max) return out;
      out.push({ fecha: d.fecha, hora });
    }
  }
  return out;
}


/**
 * Lo que tocó en una lista o un botón, con su id: el agente necesita el id ("servicio:<id>", "reservar:<id>",
 * "horario:<servicio>:<fecha>:<hora>") para seguir la reserva sin volver a preguntar.
 */
export function textoDeOpcion(titulo: string, id: string): string {
  return `${titulo}\n\n(Tocó la opción «${titulo}» · ${id})`;
}
