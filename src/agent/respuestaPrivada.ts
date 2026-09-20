import { buscarGuia, mensajeGuia } from "../config/guias.js";

/** Lo mínimo que se necesita del canal para decidir; evita arrastrar el tipo completo (y su acceso a la base) a los tests. */
export interface ConfigRespuestaPrivada {
  activo: boolean;
  ia_comentarios_activa: boolean;
  texto_respuesta_privada: string | null;
}

export interface RespuestaPrivada {
  texto: string;
  /** Clave de la guía enviada, si el comentario la pedía. */
  guia?: string;
}

/**
 * Qué se le contesta por privado a quien comenta, o null si no se contesta.
 *
 * Meta solo deja UNA respuesta privada por comentario, así que el interruptor
 * del canal manda sobre todo: con `activo` o `ia_comentarios_activa` apagados
 * no sale nada, ni siquiera una guía. Solo el comentario original cuenta, no
 * las respuestas anidadas.
 *
 * Con la palabra clave de una guía sale el enlace a esa guía; sin ella, sale el
 * texto fijo del canal, como antes (y si tampoco hay texto fijo, nada).
 */
export function elegirRespuestaPrivada(params: {
  texto: string;
  parentId?: string | null;
  config: ConfigRespuestaPrivada | null;
}): RespuestaPrivada | null {
  const { config } = params;
  if (!config?.activo || !config.ia_comentarios_activa || params.parentId) return null;

  const guia = buscarGuia(params.texto);
  if (guia) return { texto: mensajeGuia(guia), guia: guia.clave };

  if (config.texto_respuesta_privada) return { texto: config.texto_respuesta_privada };
  return null;
}
