/**
 * Qué hacer con un mensaje programado cuando llega su hora. Reglas puras para
 * probarlas sin base de datos ni WhatsApp.
 */

/** Si el bot estuvo caído y la hora se pasó por más de esto, el mensaje llegaría fuera de lugar. */
export const TOLERANCIA_ATRASO_MS = 2 * 60 * 60_000;

export type Decision =
  | { accion: "enviar" }
  | { accion: "fallido"; detalle: string }
  | { accion: "cancelado"; detalle: string };

export function decidirProgramado(params: {
  ahora: Date;
  programadoPara: Date;
  cancelarSiResponde: boolean;
  /** ¿Escribió la clienta después de que se programó el mensaje? */
  escribioDespues: boolean;
}): Decision {
  if (params.ahora.getTime() - params.programadoPara.getTime() > TOLERANCIA_ATRASO_MS) {
    return { accion: "fallido", detalle: "Se pasó la hora por más de 2 h (el bot no estaba corriendo). No se mandó." };
  }
  if (params.cancelarSiResponde && params.escribioDespues) {
    return { accion: "cancelado", detalle: "Ella escribió antes de la hora: no hizo falta." };
  }
  return { accion: "enviar" };
}
