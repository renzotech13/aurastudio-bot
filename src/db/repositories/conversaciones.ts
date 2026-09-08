import { supabase } from "../client.js";

export type CanalConversacion = "whatsapp" | "messenger" | "instagram";
export type OrigenConversacion = "dm" | "comentario";
export type EstadoConversacion = "activa" | "escalada" | "cerrada";
export type EtapaConversacion = "nuevo" | "en_atencion" | "calificado" | "agendado" | "cerrado";

export type Conversacion = {
  id: string;
  cliente_id: string;
  canal: CanalConversacion;
  origen: OrigenConversacion;
  identidad_id: string | null;
  hilo_externo: string | null;
  cuenta_id: string | null;
  ultimo_mensaje_at: string;
  ultimo_comentario_at: string | null;
  /** Quién responde: 'activa' el bot, 'escalada' una persona, 'cerrada' nadie. */
  estado: EstadoConversacion;
  /** En qué punto va el lead. Lo mueven triggers de Postgres, no este código. */
  etapa: EtapaConversacion;
  asignada_a: string | null;
  created_at: string;
};

/** Una conversación sigue "abierta" mientras no se archive, la atienda el bot o una persona. */
const ESTADOS_ABIERTOS: EstadoConversacion[] = ["activa", "escalada"];

/**
 * Reutiliza la conversación ABIERTA del cliente en ese canal e hilo; solo crea
 * una nueva si la última quedó cerrada.
 *
 * Antes buscaba únicamente estado='activa', y ese detalle anulaba por completo
 * la intervención humana: en cuanto una conversación pasaba a 'escalada', el
 * siguiente mensaje de la clienta no la encontraba, se creaba una conversación
 * nueva en 'activa', y el bot volvía a responder por encima de la persona que
 * ya estaba atendiendo. El `if (conversacion.estado === "escalada")` de
 * handleMessage.ts nunca llegaba a cumplirse.
 *
 * El hilo distingue los comentarios: los de una misma persona sobre una misma
 * publicación son una conversación, y sus DMs son otra.
 */
export async function getOrCreateConversacionAbierta(params: {
  clienteId: string;
  canal?: CanalConversacion;
  origen?: OrigenConversacion;
  identidadId?: string | null;
  hiloExterno?: string | null;
  cuentaId?: string | null;
}): Promise<Conversacion> {
  const canal = params.canal ?? "whatsapp";
  const origen = params.origen ?? "dm";
  const hiloExterno = params.hiloExterno ?? null;

  const buscar = () => {
    const query = supabase
      .from("conversaciones")
      .select("*")
      .eq("cliente_id", params.clienteId)
      .eq("canal", canal)
      .eq("origen", origen)
      .in("estado", ESTADOS_ABIERTOS)
      .order("ultimo_mensaje_at", { ascending: false })
      .limit(1);
    return hiloExterno === null ? query.is("hilo_externo", null) : query.eq("hilo_externo", hiloExterno);
  };

  const { data: existente, error: findError } = await buscar().maybeSingle();
  if (findError) throw findError;
  if (existente) return existente as Conversacion;

  const { data: creada, error: insertError } = await supabase
    .from("conversaciones")
    .insert({
      cliente_id: params.clienteId,
      canal,
      origen,
      identidad_id: params.identidadId ?? null,
      hilo_externo: hiloExterno,
      cuenta_id: params.cuentaId ?? null,
    })
    .select("*")
    .single();

  if (insertError) {
    // 23505 = unique_violation contra el índice parcial (identidad, hilo) de
    // la migración 0017: dos mensajes de la misma persona llegaron casi a la
    // vez y ambos intentaron abrir la conversación. El que perdió la carrera
    // relee la que acaba de crear el otro, igual que findOrCreateByPhone().
    if (insertError.code === "23505") {
      const { data: reintento, error: retryError } = await buscar().maybeSingle();
      if (retryError) throw retryError;
      if (reintento) return reintento as Conversacion;
    }
    throw insertError;
  }
  return creada as Conversacion;
}

export async function escalarConversacion(conversacionId: string): Promise<void> {
  const { error } = await supabase.from("conversaciones").update({ estado: "escalada" }).eq("id", conversacionId);
  if (error) throw error;
}

/**
 * Conversación + teléfono del cliente en una sola consulta. La usa el panel
 * admin al responder: necesita saber a qué número enviar sin hacer un
 * segundo viaje a clientes.
 */
export async function getConversacionConCliente(
  conversacionId: string,
): Promise<{ conversacion: Conversacion; telefono: string | null; clienteId: string } | null> {
  const { data, error } = await supabase
    .from("conversaciones")
    .select("*, clientes!inner(id, telefono)")
    .eq("id", conversacionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { clientes, ...conversacion } = data as Conversacion & { clientes: { id: string; telefono: string | null } };
  return { conversacion, telefono: clientes.telefono, clienteId: clientes.id };
}
