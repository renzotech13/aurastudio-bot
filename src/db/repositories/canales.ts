import { supabase } from "../client.js";
import type { CanalActivo } from "../../canales/types.js";

export type CanalConfig = {
  canal: CanalActivo;
  activo: boolean;
  ia_activa: boolean;
  ia_comentarios_activa: boolean;
  texto_respuesta_privada: string | null;
  cuenta_id: string | null;
  cuenta_nombre: string | null;
};

/**
 * null si la fila no existe (no debería pasar — la 0017 siembra las tres),
 * pero quien llama trata "no encontrado" igual que "apagado": sin
 * configuración, mejor no responder que responder con datos que no existen.
 */
export async function getCanalConfig(canal: CanalActivo): Promise<CanalConfig | null> {
  const { data, error } = await supabase.from("canales").select("*").eq("canal", canal).maybeSingle();
  if (error) throw error;
  return data as CanalConfig | null;
}

/** Los llena estadoConexion() al arrancar el servidor (ver index.ts) — nunca bloquea el arranque. */
export async function actualizarEstadoCanal(
  canal: CanalActivo,
  datos: { cuentaId?: string | undefined; cuentaNombre?: string | undefined; ultimoWebhookAt?: Date },
): Promise<void> {
  const { error } = await supabase
    .from("canales")
    .update({
      ...(datos.cuentaId !== undefined ? { cuenta_id: datos.cuentaId } : {}),
      ...(datos.cuentaNombre !== undefined ? { cuenta_nombre: datos.cuentaNombre } : {}),
      ...(datos.ultimoWebhookAt ? { ultimo_webhook_at: datos.ultimoWebhookAt.toISOString() } : {}),
    })
    .eq("canal", canal);
  if (error) throw error;
}
