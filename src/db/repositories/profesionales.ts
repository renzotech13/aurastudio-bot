import { supabase } from "../client.js";

export type Sede = {
  id: string;
  nombre: string;
  direccion: string;
  yape_numero: string | null;
  yape_titular: string | null;
};

export type Profesional = {
  id: string;
  slug: string;
  nombre: string;
  sede_id: string;
  rol: string;
  foto_url: string | null;
};

export async function listarSedes(): Promise<Sede[]> {
  const { data, error } = await supabase
    .from("sedes")
    .select("id,nombre,direccion,yape_numero,yape_titular")
    .eq("activa", true)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as Sede[];
}

/**
 * Profesionales activas de una sede que hacen TODOS los servicios pedidos.
 *
 * El "todos" importa: la clienta puede elegir varios servicios en la misma
 * reserva y se agendan consecutivos con la misma persona, así que alguien que
 * sólo hace uno de los tres no sirve. Con la carta real esto sí filtra —
 * Victoria Ponce, por ejemplo, hace cabello y color completos pero sólo 4 de
 * los 11 de manicure, así que "corte + uñas híbridas" la deja fuera.
 */
export async function listarProfesionalesParaServicios(params: {
  sedeId: string;
  servicioIds: string[];
}): Promise<Profesional[]> {
  if (params.servicioIds.length === 0) return [];

  const { data: candidatas, error: errProf } = await supabase
    .from("profesionales")
    .select("id,slug,nombre,sede_id,rol,foto_url")
    .eq("sede_id", params.sedeId)
    .eq("activa", true)
    .order("sort_order");
  if (errProf) throw errProf;
  if (!candidatas?.length) return [];

  const ids = candidatas.map((p) => p.id as string);
  const { data: mapeo, error: errMapeo } = await supabase
    .from("profesional_servicios")
    .select("profesional_id,servicio_id")
    .in("profesional_id", ids)
    .in("servicio_id", params.servicioIds);
  if (errMapeo) throw errMapeo;

  const cuenta = new Map<string, Set<string>>();
  for (const fila of mapeo ?? []) {
    const pid = fila.profesional_id as string;
    if (!cuenta.has(pid)) cuenta.set(pid, new Set());
    cuenta.get(pid)!.add(fila.servicio_id as string);
  }

  const pedidos = new Set(params.servicioIds);
  return (candidatas as Profesional[]).filter((p) => cuenta.get(p.id)?.size === pedidos.size);
}

/** Una profesional concreta, para validar lo que llega del formulario web. */
export async function getProfesionalById(id: string): Promise<Profesional | null> {
  const { data, error } = await supabase
    .from("profesionales")
    .select("id,slug,nombre,sede_id,rol,foto_url")
    .eq("id", id)
    .eq("activa", true)
    .maybeSingle();
  if (error) throw error;
  return (data as Profesional) ?? null;
}
