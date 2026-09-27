import { supabase } from "../client.js";
import type { MetodoPago } from "../../lib/equipoReglas.js";

/**
 * Consultas de lo que hace una profesional desde su app. Las que reciben su
 * `profesionalId` filtran por él en la propia consulta. La excepción es
 * getCitaPorId, que devuelve la dueña para que la RUTA decida (ver abajo).
 */

/**
 * La cita y de quién es (`profesional_id`, null si nunca se le asignó una).
 * NO filtra por profesional: decidir si es de quien la pide es trabajo de
 * citaEsDeProfesional(), a la vista en la ruta y con pruebas. Si el filtro
 * viviera acá dentro, la ruta no tendría nada que comprobar y una futura ruta
 * que reuse esta función pensaría que ya viene comprobado.
 */
export async function getCitaPorId(
  citaId: string,
): Promise<{ id: string; estado: string; profesional_id: string | null } | null> {
  const { data, error } = await supabase
    .from("citas")
    .select("id,estado,profesional_id")
    .eq("id", citaId)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string; estado: string; profesional_id: string | null } | null) ?? null;
}

/**
 * ¿Esta clienta ya tiene (o tuvo) una cita con ella? Es lo que la hace «suya».
 * Las canceladas no cuentan: es el mismo criterio de mis_clientas() en la base,
 * para que la app no ofrezca una clienta que la función no devuelve.
 */
export async function clienteEsDeProfesional(clienteId: string, profesionalId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("citas")
    .select("id", { count: "exact", head: true })
    .eq("cliente_id", clienteId)
    .eq("profesional_id", profesionalId)
    .neq("estado", "cancelada");
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Los servicios que ella hace, según `profesional_servicios`. */
export async function serviciosDeProfesional(profesionalId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("profesional_servicios")
    .select("servicio_id")
    .eq("profesional_id", profesionalId);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.servicio_id as string));
}

/** La caja abierta de un local, si la hay. Es donde cae la venta que ella anota. */
export async function cajaAbiertaEnSede(sedeId: string): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("caja_sesiones")
    .select("id")
    .eq("sede_id", sedeId)
    .eq("estado", "abierta")
    .order("apertura_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null) ?? null;
}

/**
 * Anota un ingreso de categoría «producto» a nombre de la profesional.
 * `registrado_por` es su usuario, así en Caja se ve quién lo anotó.
 */
export async function registrarVentaProducto(params: {
  sesionId: string;
  concepto: string;
  monto: number;
  metodo: MetodoPago;
  profesionalId: string;
  usuarioId: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("movimientos_caja")
    .insert({
      sesion_id: params.sesionId,
      tipo: "ingreso",
      categoria: "producto",
      concepto: params.concepto,
      monto: params.monto,
      metodo: params.metodo,
      profesional_id: params.profesionalId,
      registrado_por: params.usuarioId,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: string };
}
