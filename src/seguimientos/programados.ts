import { supabase } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { getConversacionConDestino } from "../db/repositories/conversaciones.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import { getCanalAdapter } from "../canales/index.js";
import { decidirProgramado } from "./programadosReglas.js";

/**
 * Mensajes que alguien del equipo programó desde el chat («hoy 4:30 pm:
 * recuérdale que atendemos hasta las 5»). Cada minuto se mandan los que ya
 * tocan, como si los hubiera escrito esa persona desde el panel.
 *
 * Si la clienta escribió después de programarlo (y así se pidió), no se manda:
 * ya retomó la conversación. Si el bot estuvo caído y se pasó la hora por más
 * de 2 h, tampoco: llegaría fuera de lugar. Ver programadosReglas.ts.
 */

const INTERVALO_MS = 60_000;

type Programado = {
  id: string;
  conversacion_id: string;
  texto: string;
  programado_para: string;
  cancelar_si_responde: boolean;
  creado_por: string | null;
  created_at: string;
};

async function cerrar(
  id: string,
  estado: "enviado" | "fallido" | "cancelado",
  extra: { detalle?: string; mensajeId?: string } = {},
) {
  const { error } = await supabase
    .from("mensajes_programados")
    .update({
      estado,
      detalle: extra.detalle ?? null,
      mensaje_id: extra.mensajeId ?? null,
      ...(estado === "enviado" ? { enviado_at: new Date().toISOString() } : {}),
    })
    .eq("id", id);
  if (error) logger.error({ err: error, id }, "No se pudo cerrar un mensaje programado");
}

async function enviarUno(p: Programado, ahora: Date): Promise<void> {
  // Reserva: solo una vuelta (o una instancia del bot) lo pasa de pendiente a
  // enviando, así nunca sale dos veces.
  const { data: reservado, error } = await supabase
    .from("mensajes_programados")
    .update({ estado: "enviando" })
    .eq("id", p.id)
    .eq("estado", "pendiente")
    .select("id");
  if (error) throw error;
  if (!reservado || reservado.length === 0) return;

  let escribioDespues = false;
  if (p.cancelar_si_responde) {
    const { data: escribio } = await supabase
      .from("mensajes")
      .select("id")
      .eq("conversacion_id", p.conversacion_id)
      .eq("rol", "user")
      .gt("created_at", p.created_at)
      .limit(1);
    escribioDespues = !!escribio && escribio.length > 0;
  }

  const decision = decidirProgramado({
    ahora,
    programadoPara: new Date(p.programado_para),
    cancelarSiResponde: p.cancelar_si_responde,
    escribioDespues,
  });
  if (decision.accion !== "enviar") return cerrar(p.id, decision.accion, { detalle: decision.detalle });

  const found = await getConversacionConDestino(p.conversacion_id);
  if (!found || !found.destinatarioId) {
    return cerrar(p.id, "fallido", { detalle: "La conversación no tiene a quién enviarle." });
  }

  const adapter = getCanalAdapter(found.conversacion.canal);
  const r = await adapter.enviarTexto({
    destinatarioId: found.destinatarioId,
    texto: p.texto,
    rol: "humano",
    ultimoMensajeAt: found.conversacion.ultimo_mensaje_at,
  });
  if (!r.externalId) {
    return cerrar(p.id, "fallido", { detalle: r.motivoCierre ?? "Se cerró la ventana de 24 h de WhatsApp." });
  }

  const mensaje = await guardarMensaje({
    conversacionId: p.conversacion_id,
    rol: "humano",
    contenido: p.texto,
    externalId: r.externalId,
    ...(found.conversacion.canal === "whatsapp" ? { waMessageId: r.externalId } : {}),
    ...(p.creado_por ? { autorId: p.creado_por } : {}),
  });
  await cerrar(p.id, "enviado", { mensajeId: mensaje.id });
  logger.info({ id: p.id, conversacionId: p.conversacion_id }, "Mensaje programado enviado");
}

export async function enviarProgramados(ahora = new Date()): Promise<void> {
  const { data, error } = await supabase
    .from("mensajes_programados")
    .select("id, conversacion_id, texto, programado_para, cancelar_si_responde, creado_por, created_at")
    .eq("estado", "pendiente")
    .lte("programado_para", ahora.toISOString())
    .order("programado_para")
    .limit(20);
  if (error) {
    // Sin la migración 0021 la tabla no existe: se avisa en cada vuelta y el resto del bot sigue igual.
    logger.warn({ err: error }, "No se pudieron leer los mensajes programados");
    return;
  }
  for (const p of (data ?? []) as Programado[]) {
    try {
      await enviarUno(p, ahora);
    } catch (err) {
      logger.error({ err, id: p.id }, "Falló un mensaje programado");
      await cerrar(p.id, "fallido", { detalle: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function iniciarProgramados(): void {
  const vuelta = () => {
    enviarProgramados().catch((err: unknown) => logger.error({ err }, "Falló una vuelta de mensajes programados"));
  };
  setTimeout(vuelta, 20_000);
  setInterval(vuelta, INTERVALO_MS);
  logger.info("Mensajes programados activos (revisa cada minuto)");
}
