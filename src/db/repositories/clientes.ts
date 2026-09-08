import { supabase } from "../client.js";

export type CanalOrigen = "whatsapp" | "messenger" | "instagram" | "web" | "manual";

export type Cliente = {
  id: string;
  /** Null desde la 0017: un lead de Instagram no tiene número hasta que lo da. */
  telefono: string | null;
  nombre: string | null;
  email: string | null;
  notas: string | null;
  canal_origen: CanalOrigen;
  created_at: string;
  updated_at: string;
};

/** Busca un cliente por su teléfono (wa_id de Meta); lo crea si no existe. */
export async function findOrCreateByPhone(telefono: string, nombre?: string): Promise<Cliente> {
  const { data: existing, error: findError } = await supabase
    .from("clientes")
    .select("*")
    .eq("telefono", telefono)
    .maybeSingle();

  if (findError) throw findError;
  if (existing) return existing as Cliente;

  const { data: created, error: insertError } = await supabase
    .from("clientes")
    .insert({ telefono, nombre: nombre ?? null })
    .select("*")
    .single();

  if (insertError) {
    // 23505 = unique_violation: dos mensajes del mismo número llegaron casi
    // a la vez y ambos intentaron crear el cliente. El que perdió la carrera
    // simplemente relee la fila que el otro acaba de insertar.
    if (insertError.code === "23505") {
      const { data: retried, error: retryError } = await supabase
        .from("clientes")
        .select("*")
        .eq("telefono", telefono)
        .single();
      if (retryError) throw retryError;
      return retried as Cliente;
    }
    throw insertError;
  }
  return created as Cliente;
}

/**
 * Un lead que llega por Messenger o Instagram: sin teléfono todavía, con
 * `canal_origen` marcando por dónde entró. Lo usa meta/identidades.ts al
 * resolver una identidad que nunca se había visto.
 */
export async function crearClienteLead(params: { nombre: string | null; canalOrigen: "messenger" | "instagram" }): Promise<Cliente> {
  const { data, error } = await supabase
    .from("clientes")
    .insert({ nombre: params.nombre, canal_origen: params.canalOrigen })
    .select("*")
    .single();
  if (error) throw error;
  return data as Cliente;
}

export async function guardarEmailCliente(clienteId: string, email: string): Promise<void> {
  const { error } = await supabase.from("clientes").update({ email }).eq("id", clienteId);
  if (error) throw error;
}

export async function guardarNombreCliente(clienteId: string, nombre: string): Promise<void> {
  const { error } = await supabase.from("clientes").update({ nombre }).eq("id", clienteId);
  if (error) throw error;
}

/**
 * Escribe el teléfono directo — quien llama ya tiene que haber confirmado
 * que no pertenece a otra clienta (ver `getClienteByTelefono` + fusión en
 * `guardar_datos_contacto` y en `POST /admin/clientes/:id/telefono`). El
 * trigger `clientes_telefono_califica` de la 0017 hace el resto: si pasaba
 * de null a un valor, las conversaciones abiertas de esta clienta suben a
 * etapa 'calificado' solas.
 */
export async function guardarTelefonoCliente(clienteId: string, telefono: string): Promise<void> {
  const { error } = await supabase.from("clientes").update({ telefono }).eq("id", clienteId);
  if (error) throw error;
}

export async function getClienteByTelefono(telefono: string): Promise<Cliente | null> {
  const { data, error } = await supabase.from("clientes").select("*").eq("telefono", telefono).maybeSingle();
  if (error) throw error;
  return data as Cliente | null;
}

/**
 * `fusionar_clientes` (función SQL de la 0017) mueve identidades,
 * conversaciones, citas, etiquetas, notificaciones y movimientos de caja del
 * origen al destino en una sola transacción, y borra el origen. La función
 * exige `is_staff()` solo cuando hay `auth.uid()` — el bot la llama con
 * service role, sin sesión de usuario, y esa excepción está documentada en
 * la propia migración justo para este caso.
 */
export async function fusionarClientes(origenId: string, destinoId: string): Promise<void> {
  const { error } = await supabase.rpc("fusionar_clientes", { p_origen: origenId, p_destino: destinoId });
  if (error) throw error;
}

export async function getClienteById(id: string): Promise<Cliente | null> {
  const { data, error } = await supabase.from("clientes").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as Cliente | null;
}
