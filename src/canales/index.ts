import { whatsappAdapter } from "./whatsapp.js";
import { messengerAdapter, instagramAdapter } from "./meta.js";
import type { CanalActivo, CanalAdapter } from "./types.js";

const ADAPTERS: Record<CanalActivo, CanalAdapter> = {
  whatsapp: whatsappAdapter,
  messenger: messengerAdapter,
  instagram: instagramAdapter,
};

export function getCanalAdapter(canal: CanalActivo): CanalAdapter {
  return ADAPTERS[canal];
}

export type { CanalActivo, CanalAdapter, RolEnvio, ResultadoEnvioCanal } from "./types.js";
