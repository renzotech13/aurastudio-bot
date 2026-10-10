import { supabase } from "../client.js";

export type Categoria = { id: string; title: string; images: string[] };

/** Categorías activas con sus fotos (las que se suben en el panel → Servicios → categoría). */
export async function listActiveCategories(): Promise<Categoria[]> {
  const { data, error } = await supabase
    .from("service_categories")
    .select("id, title, images")
    .eq("active", true)
    .order("sort_order");
  if (error) throw error;
  return ((data ?? []) as Categoria[]).map((c) => ({ ...c, images: c.images ?? [] }));
}
