import { env } from "../config/env.js";
import { supabase } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { sendTemplate, sendText } from "../whatsapp/client.js";
import { isWindowOpenFor } from "../whatsapp/window.js";
import { getOrCreateConversacionAbierta } from "../db/repositories/conversaciones.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import {
  dentroDeHorario,
  parametrosPlantilla,
  renderCuerpo,
  unaPorClienta,
  valoresDe,
  type Variable,
} from "./reactivacionReglas.js";

/**
 * Reactivación de clientas ya atendidas: a quien se atendió hace N días (según
 * el servicio) y no volvió, se le escribe invitándola con una oferta.
 *
 * Quién toca lo decide la base (función `reactivacion_candidatas`, migración
 * 0022), con las reglas que la administradora edita en la app. Acá solo se
 * envía, y con cuidado:
 *   · Nace APAGADO: `reactivacion_config.activa` es un interruptor general.
 *   · Solo dentro del horario permitido (hora de Lima).
 *   · Un tope por vuelta y una sola reactivación por clienta.
 *   · Se RESERVA la fila antes de enviar: el índice único de la base impide
 *     que dos vueltas (o dos instancias) le manden lo mismo dos veces.
 *   · Un fallo en una clienta no frena a las demás, y no se reintenta solo:
 *     insistir con un envío roto cada 20 minutos dañaría la calidad del número.
 */

const INTERVALO_MS = 20 * 60_000;

type Config = {
  activa: boolean;
  max_por_vuelta: number;
  hora_desde: number;
  hora_hasta: number;
};

type Candidata = {
  regla_id: string;
  regla_nombre: string;
  plantilla: string;
  cuerpo: string;
  variables: Variable[];
  oferta: string;
  codigo: string;
  cliente_id: string;
  cliente_nombre: string | null;
  cliente_telefono: string;
  cita_id: string;
  servicio: string;
};

let enCurso = false;
let avisoTablaFaltante = false;

async function leerConfig(): Promise<Config | null> {
  const { data, error } = await supabase
    .from("reactivacion_config")
    .select("activa, max_por_vuelta, hora_desde, hora_hasta")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    // Sin la migración 0022 la tabla no existe: se avisa una sola vez, no cada 20 minutos.
    if (!avisoTablaFaltante) {
      avisoTablaFaltante = true;
      logger.warn({ err: error }, "Reactivación apagada: falta la migración 0022 en la base");
    }
    return null;
  }
  return (data as Config | null) ?? null;
}

/** Lo que se le mandó queda también en su chat, para que el equipo y el bot sepan qué se le ofreció. */
async function registrarEnElChat(c: Candidata, texto: string, externalId: string | undefined): Promise<void> {
  try {
    const conversacion = await getOrCreateConversacionAbierta({ clienteId: c.cliente_id, canal: "whatsapp" });
    await guardarMensaje({
      conversacionId: conversacion.id,
      rol: "assistant",
      contenido: texto,
      ...(externalId ? { externalId, waMessageId: externalId } : {}),
      metadata: { reactivacion: c.regla_id, oferta: c.oferta, codigo: c.codigo },
    });
  } catch (err) {
    // Que no quede en el chat no deshace el envío: se avisa y se sigue.
    logger.error({ err, clienteId: c.cliente_id }, "La reactivación salió pero no se pudo anotar en el chat");
  }
}

async function enviarUna(c: Candidata): Promise<"enviada" | "omitida" | "fallida"> {
  const valores = valoresDe({
    clienteNombre: c.cliente_nombre,
    servicio: c.servicio,
    oferta: c.oferta,
    codigo: c.codigo,
  });
  const texto = renderCuerpo(c.cuerpo, c.variables, valores);

  const { data: reservada, error: errReserva } = await supabase
    .from("reactivaciones")
    .insert({
      cliente_id: c.cliente_id,
      regla_id: c.regla_id,
      cita_origen_id: c.cita_id,
      regla_nombre: c.regla_nombre,
      oferta: c.oferta,
      codigo: c.codigo,
      texto,
    })
    .select("id")
    .single();
  if (errReserva) {
    if (errReserva.code === "23505") return "omitida"; // otra vuelta ya la reservó
    throw errReserva;
  }

  try {
    let externalId: string | undefined;
    // Dentro de las 24 h el texto libre es gratis y no depende de ninguna
    // aprobación; fuera de ellas la única vía es la plantilla de Marketing.
    if (await isWindowOpenFor(c.cliente_telefono)) {
      externalId = (await sendText(c.cliente_telefono, texto)) ?? undefined;
    } else {
      externalId = await sendTemplate({
        to: c.cliente_telefono,
        plantilla: c.plantilla,
        idioma: env.WHATSAPP_TEMPLATE_LANG,
        parametros: parametrosPlantilla(c.variables, valores),
      });
    }
    await supabase
      .from("reactivaciones")
      .update({ estado: "enviada", enviada_at: new Date().toISOString(), error: null })
      .eq("id", reservada.id);
    await registrarEnElChat(c, texto, externalId);
    return "enviada";
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    await supabase
      .from("reactivaciones")
      .update({ estado: "fallida", error: motivo.slice(0, 500) })
      .eq("id", reservada.id);
    logger.error({ err, clienteId: c.cliente_id, regla: c.regla_nombre }, "No se pudo enviar una reactivación");
    return "fallida";
  }
}

export async function enviarReactivaciones(ahora = new Date()): Promise<void> {
  if (enCurso) return;
  enCurso = true;
  try {
    const config = await leerConfig();
    if (!config?.activa) return;
    if (!dentroDeHorario(ahora, config.hora_desde, config.hora_hasta)) return;

    const { data, error } = await supabase.rpc("reactivacion_candidatas", { p_ahora: ahora.toISOString() });
    if (error) {
      logger.error({ err: error }, "No se pudieron leer las candidatas de reactivación");
      return;
    }

    const lista = unaPorClienta((data ?? []) as Candidata[]).slice(0, config.max_por_vuelta);
    if (lista.length === 0) return;

    const resumen = { enviada: 0, omitida: 0, fallida: 0 };
    for (const c of lista) {
      try {
        resumen[await enviarUna(c)]++;
      } catch (err) {
        resumen.fallida++;
        logger.error({ err, clienteId: c.cliente_id }, "Falló una reactivación");
      }
    }
    logger.info({ ...resumen, candidatas: lista.length }, "Vuelta de reactivación terminada");
  } finally {
    enCurso = false;
  }
}

export function iniciarReactivacion(): void {
  const vuelta = () => {
    enviarReactivaciones().catch((err: unknown) => logger.error({ err }, "Falló una vuelta de reactivación"));
  };
  setTimeout(vuelta, 60_000);
  setInterval(vuelta, INTERVALO_MS);
  logger.info("Reactivación de clientas lista (revisa cada 20 minutos; apagada hasta que se prenda desde la app)");
}
