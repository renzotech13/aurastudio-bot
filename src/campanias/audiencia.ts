import { supabase } from "../db/client.js";
import { FRASES_BAJA, type DefinicionPlantilla } from "./plantillas.js";

/**
 * A quién le llega cada plantilla de campaña y a quién se excluye (y por qué), para que el panel lo muestre antes de
 * mandar nada. Solo lee. Las reglas de exclusión valen para todas las campañas:
 * - ya recibió esta plantilla (no se le repite),
 * - tocó «Detener promociones» o escribió algo equivalente,
 * - ya reservó desde que empezó la campaña,
 * - está conversando ahora (escribió hace menos de 20 h): a ella le responde el bot o el equipo, no una plantilla.
 */

export type Destinatario = {
  clienteId: string;
  nombre: string | null;
  telefono: string;
  /** Su conversación de WhatsApp más reciente, para dejar el envío guardado en su chat. */
  conversacionId: string | null;
};

export type MotivoExclusion = "ya_recibio" | "pidio_baja" | "ya_reservo" | "conversando";

export const MOTIVOS: Record<MotivoExclusion, string> = {
  ya_recibio: "Ya la recibió",
  pidio_baja: "Pidió no recibir promociones",
  ya_reservo: "Ya reservó en la campaña",
  conversando: "Está conversando ahora (menos de 20 h)",
};

export type Audiencia = {
  revisadas: number;
  destinatarios: Destinatario[];
  excluidas: Record<MotivoExclusion, number>;
};

const VENTANA_CONVERSANDO_MS = 20 * 60 * 60_000;
const PAGINA = 1000;

/** Supabase devuelve como mucho 1000 filas por consulta: se pide por páginas hasta que no venga una llena. */
async function todas<T>(consulta: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const filas: T[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await consulta(desde, desde + PAGINA - 1);
    if (error) throw error;
    filas.push(...(data ?? []));
    if (!data || data.length < PAGINA) return filas;
  }
}

/** Medianoche de Lima del día dado, en ISO UTC. */
function inicioDiaLima(iso: string): string {
  return new Date(`${iso}T00:00:00-05:00`).toISOString();
}

export async function calcularAudiencia(def: DefinicionPlantilla, ahora = new Date()): Promise<Audiencia> {
  const excluidas: Record<MotivoExclusion, number> = { ya_recibio: 0, pidio_baja: 0, ya_reservo: 0, conversando: 0 };
  if (def.audiencia === "automatica") return { revisadas: 0, destinatarios: [], excluidas };

  const desdeCampana = inicioDiaLima(def.campanaDesde ?? "2000-01-01");

  const [clientes, conversaciones, citas, recibidas, bajas] = await Promise.all([
    todas<{ id: string; nombre: string | null; telefono: string }>((a, b) =>
      supabase.from("clientes").select("id, nombre, telefono").not("telefono", "is", null).order("id").range(a, b),
    ),
    todas<{ id: string; cliente_id: string; created_at: string; ultimo_mensaje_at: string }>((a, b) =>
      supabase
        .from("conversaciones")
        .select("id, cliente_id, created_at, ultimo_mensaje_at")
        .eq("canal", "whatsapp")
        .order("id")
        .range(a, b),
    ),
    todas<{ cliente_id: string }>((a, b) =>
      supabase.from("citas").select("cliente_id").gte("created_at", desdeCampana).neq("estado", "cancelada").order("id").range(a, b),
    ),
    todas<{ cliente_id: string }>((a, b) =>
      supabase
        .from("notificaciones")
        .select("cliente_id")
        .eq("tipo", "promocion")
        .eq("plantilla", def.nombre)
        .in("estado", ["pendiente", "enviada"])
        .order("id")
        .range(a, b),
    ),
    todas<{ conversacion_id: string }>((a, b) =>
      supabase
        .from("mensajes")
        .select("conversacion_id")
        .eq("rol", "user")
        .or(FRASES_BAJA.map((f) => `contenido.ilike."${f.replace(/[,()"]/g, "")}*"`).join(","))
        .order("id")
        .range(a, b),
    ),
  ]);

  // Por clienta: su conversación de WhatsApp más reciente, cuándo escribió por última vez y si llegó durante la campaña.
  const porCliente = new Map<string, { conversacionId: string; ultimo: number; llegoEnCampana: boolean }>();
  for (const c of conversaciones) {
    const ultimo = Date.parse(c.ultimo_mensaje_at);
    const previo = porCliente.get(c.cliente_id);
    const llego = c.created_at >= desdeCampana || Boolean(previo?.llegoEnCampana);
    if (!previo || ultimo > previo.ultimo) porCliente.set(c.cliente_id, { conversacionId: c.id, ultimo, llegoEnCampana: llego });
    else previo.llegoEnCampana = llego;
  }
  const clienteDeConversacion = new Map(conversaciones.map((c) => [c.id, c.cliente_id]));
  const conBaja = new Set(bajas.map((m) => clienteDeConversacion.get(m.conversacion_id)).filter(Boolean));
  const reservaron = new Set(citas.map((c) => c.cliente_id));
  const yaRecibieron = new Set(recibidas.map((n) => n.cliente_id));

  const candidatas = clientes.filter((c) => {
    if (def.audiencia === "clientas" || def.audiencia === "todas") return true;
    return Boolean(porCliente.get(c.id)?.llegoEnCampana); // leads: escribieron durante la campaña
  });

  const destinatarios: Destinatario[] = [];
  for (const c of candidatas) {
    const conv = porCliente.get(c.id);
    if (yaRecibieron.has(c.id)) excluidas.ya_recibio++;
    else if (conBaja.has(c.id)) excluidas.pidio_baja++;
    else if (reservaron.has(c.id)) excluidas.ya_reservo++;
    else if (conv && ahora.getTime() - conv.ultimo < VENTANA_CONVERSANDO_MS) excluidas.conversando++;
    else destinatarios.push({ clienteId: c.id, nombre: c.nombre, telefono: c.telefono, conversacionId: conv?.conversacionId ?? null });
  }
  return { revisadas: candidatas.length, destinatarios, excluidas };
}
