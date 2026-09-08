/**
 * Mismo criterio que `normalizarTelefono()` de ImportarClientesDialog.tsx en
 * el panel — se repite acá porque son dos runtimes distintos (bot y panel),
 * pero la regla tiene que ser idéntica: si un teléfono se normaliza distinto
 * en cada lado, `clientes.telefono` (unique) puede terminar con dos filas
 * para la misma persona.
 */
export function normalizarTelefono(crudo: string): string | null {
  const digitos = crudo.replace(/\D/g, "");
  if (digitos.length === 9 && digitos.startsWith("9")) return `51${digitos}`;
  if (digitos.length === 11 && digitos.startsWith("51")) return digitos;
  return digitos.length >= 8 ? digitos : null;
}
