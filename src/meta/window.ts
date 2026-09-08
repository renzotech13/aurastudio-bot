export type ModoEnvioMeta = "RESPONSE" | "HUMAN_AGENT";

export type EstadoVentanaMeta = { abierta: true; modo: ModoEnvioMeta } | { abierta: false; motivo: string };

const VENTANA_RESPONSE_MS = 24 * 60 * 60_000;
const VENTANA_HUMAN_AGENT_MS = 7 * 24 * 60 * 60_000;

/**
 * Calcula si se puede escribir ahora mismo a alguien de Messenger/Instagram,
 * y con qué `messaging_type` — distinto de la ventana de WhatsApp
 * (whatsapp/window.ts), que no tiene el tramo intermedio de Human Agent.
 *
 * - Menos de 24h desde el último mensaje ENTRANTE: cualquiera (bot o humano)
 *   responde con RESPONSE.
 * - Entre 24h y 7 días: SOLO un humano, y solo si Meta aprobó la función
 *   Human Agent para esta app. El bot nunca usa este tag — es justamente la
 *   política de Meta: HUMAN_AGENT es para que una persona real retome la
 *   conversación, no para seguir automatizando fuera de ventana.
 * - Más de 7 días, o nunca escribió por este canal: cerrada, sin excepción.
 */
export function calcularVentanaMeta(params: {
  ultimoMensajeAt: Date | null;
  rol: "assistant" | "humano";
  humanAgentAprobado: boolean;
  ahora?: Date;
}): EstadoVentanaMeta {
  const { ultimoMensajeAt, rol, humanAgentAprobado } = params;
  const ahora = params.ahora ?? new Date();

  if (!ultimoMensajeAt) {
    return { abierta: false, motivo: "Esta clienta nunca escribió por este canal." };
  }

  const transcurrido = ahora.getTime() - ultimoMensajeAt.getTime();

  if (transcurrido < VENTANA_RESPONSE_MS) {
    return { abierta: true, modo: "RESPONSE" };
  }

  if (transcurrido < VENTANA_HUMAN_AGENT_MS) {
    if (rol === "humano" && humanAgentAprobado) {
      return { abierta: true, modo: "HUMAN_AGENT" };
    }
    if (rol === "humano") {
      return {
        abierta: false,
        motivo:
          "Pasaron más de 24 horas desde el último mensaje. Se podría responder con la etiqueta Human Agent, pero Meta todavía no aprobó esa función para esta app.",
      };
    }
    return {
      abierta: false,
      motivo: "Pasaron más de 24 horas desde el último mensaje. Solo una persona del equipo puede retomar la conversación, el bot no.",
    };
  }

  return {
    abierta: false,
    motivo: "Pasaron más de 7 días desde el último mensaje. Ya no se puede retomar la conversación por este canal.",
  };
}
