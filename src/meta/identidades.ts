import { supabase } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { crearClienteLead, getClienteById, type Cliente } from "../db/repositories/clientes.js";
import { obtenerPerfil } from "./client.js";
import type { CanalMeta } from "./parser.js";

export type TipoIdentidad = "psid" | "igsid" | "fb_comment_user" | "ig_comment_user";

export type ClienteIdentidad = {
  id: string;
  cliente_id: string;
  canal: CanalMeta;
  tipo: TipoIdentidad;
  external_id: string;
  cuenta_id: string | null;
  nombre_perfil: string | null;
  username: string | null;
  foto_url: string | null;
};

/** psid/igsid: identidades de mensajería, con perfil consultable vía Graph API. */
const TIPOS_MENSAJERIA: ReadonlySet<TipoIdentidad> = new Set(["psid", "igsid"]);

async function buscarIdentidad(canal: CanalMeta, tipo: TipoIdentidad, externalId: string): Promise<ClienteIdentidad | null> {
  const { data, error } = await supabase
    .from("cliente_identidades")
    .select("*")
    .eq("canal", canal)
    .eq("tipo", tipo)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw error;
  return data as ClienteIdentidad | null;
}

/**
 * Resuelve la identidad de quien escribió o comentó, a la clienta que le
 * corresponde. Si es la primera vez que se ve ese `external_id` en ese canal
 * y tipo, crea la clienta (sin teléfono) y la identidad en el mismo paso.
 *
 * `nombreConocido` es lo que ya vino en el propio evento (from.name de un
 * comentario, o contactName de un mensaje) — se usa como respaldo si
 * obtenerPerfil() falla o no aplica.
 */
export async function resolverIdentidad(params: {
  canal: CanalMeta;
  tipo: TipoIdentidad;
  externalId: string;
  cuentaId: string | null;
  nombreConocido?: string | null;
  usernameConocido?: string | null;
}): Promise<{ cliente: Cliente; identidad: ClienteIdentidad }> {
  const existente = await buscarIdentidad(params.canal, params.tipo, params.externalId);

  if (existente) {
    // Se refresca el perfil en cada mensaje entrante SOLO para identidades de
    // mensajería — las de comentario no tienen una llamada de perfil fiable
    // (el `from.id` de un comentario vive en otro espacio de permisos) y ya
    // trajeron nombre/username en el propio evento al crearse.
    if (TIPOS_MENSAJERIA.has(params.tipo)) {
      const perfil = await obtenerPerfil({ canal: params.canal, id: params.externalId });
      if (perfil) {
        const { error } = await supabase
          .from("cliente_identidades")
          .update({ nombre_perfil: perfil.nombre, username: perfil.username, foto_url: perfil.fotoUrl })
          .eq("id", existente.id);
        if (error) logger.warn({ err: error }, "No se pudo refrescar el perfil de la identidad");
      }
    }
    const cliente = await getClienteById(existente.cliente_id);
    if (!cliente) throw new Error(`cliente_identidades apunta a una clienta que ya no existe: ${existente.cliente_id}`);
    return { cliente, identidad: existente };
  }

  const perfil = TIPOS_MENSAJERIA.has(params.tipo)
    ? await obtenerPerfil({ canal: params.canal, id: params.externalId })
    : null;
  const nombre = perfil?.nombre ?? params.nombreConocido ?? null;
  const username = perfil?.username ?? params.usernameConocido ?? null;

  const cliente = await crearClienteLead({ nombre, canalOrigen: params.canal });

  const { data: creada, error: insertError } = await supabase
    .from("cliente_identidades")
    .insert({
      cliente_id: cliente.id,
      canal: params.canal,
      tipo: params.tipo,
      external_id: params.externalId,
      cuenta_id: params.cuentaId,
      nombre_perfil: nombre,
      username,
      foto_url: perfil?.fotoUrl ?? null,
    })
    .select("*")
    .single();

  if (insertError) {
    // 23505 = otro evento casi simultáneo ya creó esta misma identidad —
    // se relee la que ganó la carrera. La clienta que acabamos de crear acá
    // queda huérfana (sin identidad apuntándole): un costo aceptable de la
    // carrera, no vale la pena una transacción distribuida por un caso raro.
    if (insertError.code === "23505") {
      const ganadora = await buscarIdentidad(params.canal, params.tipo, params.externalId);
      if (ganadora) {
        const clienteGanador = await getClienteById(ganadora.cliente_id);
        if (clienteGanador) return { cliente: clienteGanador, identidad: ganadora };
      }
    }
    throw insertError;
  }

  return { cliente, identidad: creada as ClienteIdentidad };
}

/**
 * Enlaza una identidad de mensajería (psid/igsid) a una clienta que ya
 * existía por otra vía — típicamente, la respuesta de una private reply
 * devuelve el `recipient_id` real de quien comentó, y eso es lo primero que
 * confirma que el comentarista y el PSID/IGSID son la misma persona (nunca
 * se puede asumir antes de esa confirmación, ver PROMPT-OMNICANAL.md §3.4).
 */
export async function vincularIdentidadMensajeria(params: {
  clienteId: string;
  canal: CanalMeta;
  tipo: "psid" | "igsid";
  externalId: string;
  cuentaId: string | null;
}): Promise<ClienteIdentidad> {
  const existente = await buscarIdentidad(params.canal, params.tipo, params.externalId);
  if (existente) return existente;

  const { data, error } = await supabase
    .from("cliente_identidades")
    .insert({
      cliente_id: params.clienteId,
      canal: params.canal,
      tipo: params.tipo,
      external_id: params.externalId,
      cuenta_id: params.cuentaId,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      const ganadora = await buscarIdentidad(params.canal, params.tipo, params.externalId);
      if (ganadora) return ganadora;
    }
    throw error;
  }
  return data as ClienteIdentidad;
}
