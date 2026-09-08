export type CanalActivo = "whatsapp" | "messenger" | "instagram";
export type RolEnvio = "assistant" | "humano";

export type ResultadoEnvioCanal = {
  /** external_id que asignó el canal, o null si la ventana estaba cerrada y no se intentó nada. */
  externalId: string | null;
  /** Solo presente cuando externalId es null: por qué no se pudo enviar. */
  motivoCierre?: string;
};

/**
 * Una sola forma de mandar texto sin que quien llama tenga que saber las
 * reglas de ventana de cada canal (WhatsApp: 24h + plantillas; Meta: 24h +
 * Human Agent entre 24h y 7 días). Cada adapter recibe lo que ya se conoce
 * — destinatario y último mensaje entrante — en vez de ir a buscarlo, para
 * no repetir la misma consulta que ya hizo quien llama.
 */
export interface CanalAdapter {
  canal: CanalActivo;
  enviarTexto(params: {
    destinatarioId: string;
    texto: string;
    rol: RolEnvio;
    /** Último mensaje ENTRANTE de esa persona por este canal; null si nunca escribió. */
    ultimoMensajeAt: string | null;
  }): Promise<ResultadoEnvioCanal>;
}
