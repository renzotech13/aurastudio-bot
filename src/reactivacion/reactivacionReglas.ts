/**
 * Reglas puras de la reactivación de clientas ya atendidas: qué valores van en
 * el mensaje, cómo se arma y cuándo se puede mandar. Sin base de datos ni
 * WhatsApp, para probarlas aparte. El envío está en reactivacion.ts.
 */

export type Variable = "nombre" | "servicio" | "oferta" | "codigo";

export type Valores = Record<Variable, string>;

/**
 * Cómo se llama a la clienta en el saludo. Un nombre de perfil raro
 * («comienza ser tu misma ☺», un emoji, un número) no puede ir tal cual en
 * «Hola …»: se cae a un saludo neutro.
 */
export const SALUDO_NEUTRO = "bella";

export function nombreParaSaludo(nombre: string | null | undefined): string {
  const completo = (nombre ?? "").trim();
  // Un nombre que lleva emojis, números o símbolos es un apodo de perfil
  // («comienza ser tu misma ☺»), no un nombre: no va en el saludo.
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s.'’-]+$/.test(completo)) return SALUDO_NEUTRO;
  const primero = completo.split(/[\s-]+/)[0] ?? "";
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,20}$/.test(primero)) return SALUDO_NEUTRO;
  return primero.charAt(0).toLocaleUpperCase("es") + primero.slice(1).toLocaleLowerCase("es");
}

export function valoresDe(params: {
  clienteNombre: string | null;
  servicio: string;
  oferta: string;
  codigo: string;
}): Valores {
  return {
    nombre: nombreParaSaludo(params.clienteNombre),
    servicio: params.servicio.trim(),
    oferta: params.oferta.trim(),
    codigo: params.codigo.trim(),
  };
}

/**
 * Los valores en el orden de las variables de la plantilla ({{1}}, {{2}}…).
 * Meta rechaza un parámetro vacío, así que uno vacío es un error de la regla
 * (se avisa en vez de mandar algo roto).
 */
export function parametrosPlantilla(variables: readonly Variable[], valores: Valores): string[] {
  const parametros = variables.map((v) => valores[v]);
  const vacio = variables.find((v) => !valores[v]);
  if (vacio) throw new Error(`La regla no tiene «${vacio}»: Meta no acepta un parámetro vacío.`);
  return parametros;
}

/** El texto tal como lo ve la clienta: el cuerpo con los {{n}} reemplazados. */
export function renderCuerpo(cuerpo: string, variables: readonly Variable[], valores: Valores): string {
  return cuerpo.replace(/\{\{(\d+)\}\}/g, (original, n: string) => {
    const variable = variables[Number(n) - 1];
    return variable ? valores[variable] : original;
  });
}

/** ¿Es hora de escribirle a alguien? `desde` inclusive, `hasta` exclusive, hora de Lima. */
export function dentroDeHorario(ahora: Date, desde: number, hasta: number): boolean {
  const hora = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/Lima", hour: "2-digit", hour12: false }).format(ahora),
  ) % 24;
  return hora >= desde && hora < hasta;
}

/**
 * Una sola reactivación por clienta por vuelta: si le tocan dos reglas a la
 * vez, la base ya las trae ordenadas (la más específica primero) y se queda la
 * primera. La siguiente la frena `separacion_dias`.
 */
export function unaPorClienta<T extends { cliente_id: string }>(candidatas: readonly T[]): T[] {
  const vistas = new Set<string>();
  const unicas: T[] = [];
  for (const c of candidatas) {
    if (vistas.has(c.cliente_id)) continue;
    vistas.add(c.cliente_id);
    unicas.push(c);
  }
  return unicas;
}
