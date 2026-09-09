import { logger } from "../lib/logger.js";
import { escalarConversacion, type Conversacion } from "../db/repositories/conversaciones.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import { getCanalConfig } from "../db/repositories/canales.js";
import { getCanalAdapter, type CanalActivo } from "../canales/index.js";
import { runAgent, FALLBACK_MESSAGE } from "./runner.js";

const AGENT_TIMEOUT_MS = 25_000;

async function runAgentWithTimeout(ctx: Parameters<typeof runAgent>[0], userText: string): Promise<string> {
  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<string>((resolve) => {
    timeoutId = setTimeout(() => resolve(FALLBACK_MESSAGE), AGENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([runAgent(ctx, userText), timeout]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

/**
 * El núcleo compartido de "llegó un mensaje de texto, hay que atenderlo",
 * usado tanto por el flujo de WhatsApp (agent/handleMessage.ts, que resuelve
 * cliente/conversación a su manera — por teléfono) como por el de
 * Messenger/Instagram (agent/handleInboundMeta.ts, que resuelve por
 * identidad). Cada canal resuelve identidad y conversación distinto —
 * WhatsApp además tiene ramas propias para audio e imagen que no aplican a
 * los canales nuevos — así que eso se queda en el wrapper de cada uno; acá
 * vive solo lo que de verdad es igual para los tres: guardar, decidir si
 * responde el bot, correr el agente, guardar la respuesta y enviarla.
 *
 * El mensaje entrante se guarda SIEMPRE, incluso si la conversación está
 * escalada o el canal tiene la IA apagada — antes (bug encontrado al
 * unificar este código) una conversación escalada ni guardaba el mensaje
 * entrante: quedaba sin rastro, y el staff no veía en el panel lo que la
 * clienta acababa de escribir.
 */
export async function handleInbound(params: {
  conversacion: Conversacion;
  canal: CanalActivo;
  /** A quién se le responde: el teléfono en WhatsApp, el PSID/IGSID en Meta. */
  destinatarioId: string;
  telefono: string | null;
  contactName: string | undefined;
  texto: string;
  externalId: string;
}): Promise<void> {
  const { conversacion } = params;

  await guardarMensaje({ conversacionId: conversacion.id, rol: "user", contenido: params.texto, externalId: params.externalId });

  if (conversacion.estado === "escalada") {
    logger.info({ conversacionId: conversacion.id }, "Conversación escalada, el bot no responde");
    return;
  }

  const canalConfig = await getCanalConfig(params.canal);
  if (!canalConfig?.activo || !canalConfig?.ia_activa) {
    logger.info({ canal: params.canal, conversacionId: conversacion.id }, "Canal o IA apagados, el bot no responde");
    return;
  }

  let respuesta: string;
  try {
    respuesta = await runAgentWithTimeout(
      {
        canal: params.canal,
        conversacionId: conversacion.id,
        clienteId: conversacion.cliente_id,
        telefono: params.telefono,
        contactName: params.contactName,
      },
      params.texto,
    );
  } catch (err) {
    logger.error({ err }, "Fallo inesperado orquestando el agente");
    respuesta = FALLBACK_MESSAGE;
    await escalarConversacion(conversacion.id).catch(() => {});
  }

  // Enviar antes de guardar: si esto tira (Meta/WhatsApp rechazó el envío,
  // no solo "ventana cerrada"), el catch lo convierte en el mismo shape que
  // motivoCierre para que el mensaje quede guardado con error_entrega en vez
  // de aparecer en el panel como si le hubiera llegado a la clienta.
  const adapter = getCanalAdapter(params.canal);
  let resultado: { externalId: string | null; motivoCierre?: string };
  try {
    resultado = await adapter.enviarTexto({
      destinatarioId: params.destinatarioId,
      texto: respuesta,
      rol: "assistant",
      // El mensaje que se está respondiendo ES el último entrante: la ventana
      // está abierta por definición en este momento, no hace falta releerla.
      ultimoMensajeAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, canal: params.canal, conversacionId: conversacion.id }, "Fallo enviando la respuesta del bot");
    resultado = { externalId: null, motivoCierre: err instanceof Error ? err.message : String(err) };
  }

  await guardarMensaje({
    conversacionId: conversacion.id,
    rol: "assistant",
    contenido: respuesta,
    ...(resultado.externalId
      ? { externalId: resultado.externalId }
      : { errorEntrega: resultado.motivoCierre ?? "No se pudo enviar" }),
  });

  if (!resultado.externalId) {
    logger.warn(
      { canal: params.canal, conversacionId: conversacion.id, motivo: resultado.motivoCierre },
      "No se pudo enviar la respuesta del bot",
    );
  }
}
