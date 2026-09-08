import { supabase } from "../client.js";

export type Sede = {
  id: string;
  nombre: string;
  direccion: string;
  maps_url: string | null;
  telefono: string | null;
};

export async function listActiveSedes(): Promise<Sede[]> {
  const { data, error } = await supabase
    .from("sedes")
    .select("id, nombre, direccion, maps_url, telefono")
    .eq("activa", true)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as Sede[];
}
