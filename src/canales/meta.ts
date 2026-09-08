import { env } from "../config/env.js";
import { calcularVentanaMeta } from "../meta/window.js";
import { enviarTexto as enviarTextoMeta } from "../meta/client.js";
import type { CanalMeta } from "../meta/parser.js";
import type { CanalAdapter, ResultadoEnvioCanal } from "./types.js";

function crearAdapterMeta(canal: CanalMeta): CanalAdapter {
  return {
    canal,
    async enviarTexto({ destinatarioId, texto, rol, ultimoMensajeAt }): Promise<ResultadoEnvioCanal> {
      const estado = calcularVentanaMeta({
        ultimoMensajeAt: ultimoMensajeAt ? new Date(ultimoMensajeAt) : null,
        rol,
        humanAgentAprobado: env.META_HUMAN_AGENT_APROBADO,
      });

      if (!estado.abierta) {
        return { externalId: null, motivoCierre: estado.motivo };
      }

      const resultado = await enviarTextoMeta({ canal, recipientId: destinatarioId, texto, modo: estado.modo });
      return { externalId: resultado.messageId };
    },
  };
}

export const messengerAdapter: CanalAdapter = crearAdapterMeta("messenger");
export const instagramAdapter: CanalAdapter = crearAdapterMeta("instagram");
