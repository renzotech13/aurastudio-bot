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

export async function guardarEmailCliente(clienteId: string, email: string): Promise<void> {
  const { error } = await supabase.from("clientes").update({ email }).eq("id", clienteId);
  if (error) throw error;
}

export async function getClienteById(id: string): Promise<Cliente | null> {
  const { data, error } = await supabase.from("clientes").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as Cliente | null;
}
