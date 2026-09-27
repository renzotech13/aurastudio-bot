import { supabase } from "../db/client.js";
import { AppError } from "./errors.js";

export type AdminUser = { id: string; email: string | null };

/**
 * Valida el JWT de Supabase que envía el panel admin y exige rol staff.
 *
 * El bot corre con la service role key, así que las políticas RLS NO lo
 * protegen: si un endpoint /admin/* no llamara a esta función, cualquiera
 * con la URL podría escribirle a los clientes. La verificación de rol es
 * explícita y obligatoria en cada ruta.
 */
export async function requireStaff(authorizationHeader: string | undefined): Promise<AdminUser> {
  const token = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice("Bearer ".length) : null;
  if (!token) throw new AppError("Falta el token de sesión", "missing_token", 401);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new AppError("Sesión inválida o expirada", "invalid_token", 401);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (profile?.role !== "staff") throw new AppError("Se requiere rol staff", "forbidden", 403);

  return { id: data.user.id, email: data.user.email ?? null };
}

export type ProfesionalUser = {
  id: string;
  email: string | null;
  /** La fila de `profesionales` a la que está enlazada su cuenta. */
  profesionalId: string;
  nombre: string;
};

/**
 * Valida el JWT y exige que la cuenta sea de una profesional ACTIVA.
 *
 * Es aparte de requireStaff a propósito: requireStaff compara `role ===
 * "staff"` y sigue así, así que una profesional NO pasa por ninguna ruta
 * /admin/* — la puerta que ya existía se queda cerrada sin tocarla. Lo que
 * ella puede hacer vive en /equipo/*, y cada ruta ahí filtra por el
 * `profesionalId` que devuelve esta función.
 *
 * Exige la fila activa (no solo el rol): desactivar a una profesional en el
 * panel le corta el acceso a las acciones en el mismo instante, igual que
 * corta su lectura (mi_profesional_id() en la migración 0020).
 */
export async function requireProfesional(authorizationHeader: string | undefined): Promise<ProfesionalUser> {
  const token = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice("Bearer ".length) : null;
  if (!token) throw new AppError("Falta el token de sesión", "missing_token", 401);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new AppError("Sesión inválida o expirada", "invalid_token", 401);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (profile?.role !== "profesional") throw new AppError("Se requiere rol profesional", "forbidden", 403);

  const { data: prof, error: profError } = await supabase
    .from("profesionales")
    .select("id,nombre")
    .eq("user_id", data.user.id)
    .eq("activa", true)
    .maybeSingle();
  if (profError) throw profError;
  if (!prof) throw new AppError("Tu usuario no está enlazado a una profesional activa", "profesional_inactiva", 403);

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    profesionalId: prof.id as string,
    nombre: prof.nombre as string,
  };
}
