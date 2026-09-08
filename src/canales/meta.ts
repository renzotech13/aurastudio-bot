import { env } from "../config/env.js";
import { calcularVentanaMeta } from "../meta/window.js";
import { enviarTexto as enviarTextoMeta, enviarAdjunto as enviarAdjuntoMeta } from "../meta/client.js";
import type { AttachmentType, CanalMeta } from "../meta/parser.js";
import type { CanalAdapter, ResultadoEnvioCanal, TipoMediaCanal } from "./types.js";

/** `TipoMediaCanal` ("document") no es un valor de `AttachmentType` de Meta ("file"): un solo caso a traducir. */
const TIPO_A_ATTACHMENT: Record<TipoMediaCanal, AttachmentType> = {
  image: "image",
  video: "video",
  audio: "audio",
  document: "file",
};

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

    async enviarMedia({ destinatarioId, tipo, url, rol, ultimoMensajeAt }): Promise<ResultadoEnvioCanal> {
      const estado = calcularVentanaMeta({
        ultimoMensajeAt: ultimoMensajeAt ? new Date(ultimoMensajeAt) : null,
        rol,
        humanAgentAprobado: env.META_HUMAN_AGENT_APROBADO,
      });

      if (!estado.abierta) {
        return { externalId: null, motivoCierre: estado.motivo };
      }

      const resultado = await enviarAdjuntoMeta({
        canal,
        recipientId: destinatarioId,
        tipo: TIPO_A_ATTACHMENT[tipo],
        url,
        modo: estado.modo,
      });
      return { externalId: resultado.messageId };
    },
  };
}

export const messengerAdapter: CanalAdapter = crearAdapterMeta("messenger");
export const instagramAdapter: CanalAdapter = crearAdapterMeta("instagram");
