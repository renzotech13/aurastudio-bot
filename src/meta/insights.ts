import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { GRAPH_BASE_URL } from "./client.js";
import { upsertMetricasContenidoDia, type CanalContenido, type MetricasContenidoDia } from "../db/repositories/metricasContenido.js";

/**
 * Foto diaria de alcance/impresiones/seguidores para `metricas_contenido_diarias`
 * (ver PROMPT-OMNICANAL.md §4.11/§5.11/§6.6). La Insights API de Meta no es un
 * histórico, así que esto se llama periódicamente desde index.ts y cada
 * corrida upsertea el día de hoy — nunca inserta filas nuevas por corrida.
 *
 * OJO — investigado el 08-09-2026, la Insights API de Meta está en pleno
 * recambio: `page_impressions` y `page_fans` (Facebook) quedaron deprecados
 * entre nov-2025 y jun-2026, y `profile_views`/`follower_count` (Instagram)
 * quedaron deprecados desde Graph API v21/v22 — todos reemplazados por
 * métricas basadas en "views" cuyo nombre exacto no se pudo confirmar contra
 * la referencia oficial completa al escribir esto (developers.facebook.com
 * no sirvió el contenido completo a un fetch automatizado). Por eso:
 *   - los seguidores NO se piden por Insights sino por `followers_count`,
 *     un campo normal del nodo de la Página/cuenta de Instagram — mucho más
 *     estable que un metric de Insights, que es justo lo que se acaba de
 *     retirar.
 *   - alcance/impresiones/interacciones sí se piden por Insights, pero cada
 *     metric se pide por separado y una que Meta rechace ("invalid metric")
 *     no tumba el resto — esa columna queda en null ese día y `crudo` guarda
 *     la respuesta cruda (o el error) para poder ajustar el nombre del
 *     metric más adelante sin perder lo que sí se obtuvo.
 * Verificar el metric exacto de "views" apenas se pueda probar contra un
 * token real, y ajustar METRICAS_FACEBOOK/METRICAS_INSTAGRAM abajo.
 */
const METRICAS_FACEBOOK = { alcance: "page_views_total", interacciones: "page_post_engagements" } as const;
const METRICAS_INSTAGRAM = { alcance: "reach", impresiones: "views", interacciones: "accounts_engaged" } as const;

function hoyLima(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

async function graphGet(path: string): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: unknown }> {
  try {
    const res = await fetch(`${GRAPH_BASE_URL}${path}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `total_value` es la forma que trae Insights para un metric de un solo número en el período pedido. */
function valorDeInsight(data: Record<string, unknown>, metric: string): number | null {
  const filas = data.data as Array<{ name?: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }> | undefined;
  const fila = filas?.find((f) => f.name === metric);
  const valor = fila?.total_value?.value ?? fila?.values?.at(-1)?.value;
  return typeof valor === "number" ? valor : null;
}

async function metricasFacebook(token: string): Promise<MetricasContenidoDia | null> {
  if (!env.META_PAGE_ID) return null;
  const crudo: Record<string, unknown> = {};

  const perfil = await graphGet(`/${env.META_PAGE_ID}?fields=followers_count&access_token=${encodeURIComponent(token)}`);
  crudo.perfil = perfil.ok ? perfil.data : perfil.error;
  const seguidores = perfil.ok ? ((perfil.data.followers_count as number | undefined) ?? null) : null;

  const metricsQuery = Object.values(METRICAS_FACEBOOK).join(",");
  const insights = await graphGet(
    `/${env.META_PAGE_ID}/insights?metric=${metricsQuery}&period=day&access_token=${encodeURIComponent(token)}`,
  );
  crudo.insights = insights.ok ? insights.data : insights.error;
  if (!insights.ok) logger.warn({ error: insights.error }, "Insights de Facebook rechazados por Meta (ver comentario en insights.ts)");

  return {
    alcance: insights.ok ? valorDeInsight(insights.data, METRICAS_FACEBOOK.alcance) : null,
    impresiones: null,
    interacciones: insights.ok ? valorDeInsight(insights.data, METRICAS_FACEBOOK.interacciones) : null,
    seguidores,
    visitasPerfil: null,
    crudo,
  };
}

async function metricasInstagram(token: string): Promise<MetricasContenidoDia | null> {
  if (!env.META_IG_ACCOUNT_ID) return null;
  const crudo: Record<string, unknown> = {};

  const perfil = await graphGet(
    `/${env.META_IG_ACCOUNT_ID}?fields=followers_count&access_token=${encodeURIComponent(token)}`,
  );
  crudo.perfil = perfil.ok ? perfil.data : perfil.error;
  const seguidores = perfil.ok ? ((perfil.data.followers_count as number | undefined) ?? null) : null;

  // reach admite metric_type=time_series; el resto de por sí ya viene como
  // total_value del período — pedirlos juntos con time_series podría hacer
  // que Meta rechace el request completo, así que van en dos llamadas.
  const reachRes = await graphGet(
    `/${env.META_IG_ACCOUNT_ID}/insights?metric=${METRICAS_INSTAGRAM.alcance}&metric_type=time_series&period=day&access_token=${encodeURIComponent(token)}`,
  );
  crudo.reach = reachRes.ok ? reachRes.data : reachRes.error;

  const restoQuery = [METRICAS_INSTAGRAM.impresiones, METRICAS_INSTAGRAM.interacciones].join(",");
  const restoRes = await graphGet(
    `/${env.META_IG_ACCOUNT_ID}/insights?metric=${restoQuery}&period=day&access_token=${encodeURIComponent(token)}`,
  );
  crudo.resto = restoRes.ok ? restoRes.data : restoRes.error;
  if (!reachRes.ok || !restoRes.ok) {
    logger.warn({ reach: reachRes.ok ? undefined : reachRes.error, resto: restoRes.ok ? undefined : restoRes.error }, "Insights de Instagram rechazados por Meta (ver comentario en insights.ts)");
  }

  return {
    alcance: reachRes.ok ? valorDeInsight(reachRes.data, METRICAS_INSTAGRAM.alcance) : null,
    impresiones: restoRes.ok ? valorDeInsight(restoRes.data, METRICAS_INSTAGRAM.impresiones) : null,
    interacciones: restoRes.ok ? valorDeInsight(restoRes.data, METRICAS_INSTAGRAM.interacciones) : null,
    seguidores,
    // profile_views quedó deprecado (ver comentario arriba) y no se encontró
    // reemplazo confirmado — null hasta poder verificarlo con un token real.
    visitasPerfil: null,
    crudo,
  };
}

const CANALES: { id: CanalContenido; obtener: (token: string) => Promise<MetricasContenidoDia | null> }[] = [
  { id: "facebook", obtener: metricasFacebook },
  { id: "instagram", obtener: metricasInstagram },
];

/** Llamado desde index.ts en un `setInterval` — nunca lanza, cada canal se guarda o falla por separado. */
export async function barrerMetricasContenido(): Promise<void> {
  if (!env.META_PAGE_ACCESS_TOKEN) return;
  const fecha = hoyLima();

  for (const { id, obtener } of CANALES) {
    try {
      const metricas = await obtener(env.META_PAGE_ACCESS_TOKEN);
      if (!metricas) continue;
      await upsertMetricasContenidoDia(id, fecha, metricas);
    } catch (err) {
      logger.error({ err, canal: id }, "Falló el barrido de métricas de contenido");
    }
  }
}
