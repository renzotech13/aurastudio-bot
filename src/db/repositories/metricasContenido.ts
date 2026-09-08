import { supabase } from "../client.js";

export type CanalContenido = "facebook" | "instagram";

export type MetricasContenidoDia = {
  alcance: number | null;
  impresiones: number | null;
  interacciones: number | null;
  seguidores: number | null;
  visitasPerfil: number | null;
  crudo: Record<string, unknown>;
};

/**
 * `on conflict do update`: el barrido corre varias veces al día (ver
 * index.ts) y cada corrida debe reemplazar la foto del día, no acumular
 * filas — es justo el criterio de aceptación de la fase 5.
 */
export async function upsertMetricasContenidoDia(
  canal: CanalContenido,
  fecha: string,
  datos: MetricasContenidoDia,
): Promise<void> {
  const { error } = await supabase.from("metricas_contenido_diarias").upsert(
    {
      canal,
      fecha,
      alcance: datos.alcance,
      impresiones: datos.impresiones,
      interacciones: datos.interacciones,
      seguidores: datos.seguidores,
      visitas_perfil: datos.visitasPerfil,
      crudo: datos.crudo,
    },
    { onConflict: "canal,fecha" },
  );
  if (error) throw error;
}
