import type { z } from "zod";

/**
 * El teléfono nunca es un parámetro que el modelo pueda pasar — siempre
 * viene del contexto que inyecta el runner a partir del remitente real del
 * mensaje de WhatsApp. Así ningún tool puede tocar citas de otro número
 * aunque el modelo se equivoque o intente pasarlo distinto.
 */
export type AgentContext = {
  canal: "whatsapp" | "messenger" | "instagram";
  conversacionId: string;
  /**
   * Mutable a propósito: si `guardar_datos_contacto` descubre que el
   * teléfono ya pertenece a otra clienta, fusiona las dos fichas y
   * actualiza esto para que el resto del turno (las tools que se llamen
   * después, en la misma pasada del loop) operen sobre la clienta correcta.
   */
  clienteId: string;
  /**
   * Null en un lead de Instagram/Messenger que todavía no dio su número —
   * las tools que operan citas lo necesitan y deben devolver un error
   * instructivo en vez de asumir nada (ver el guard al inicio de cada una).
   * También mutable: `guardar_datos_contacto` lo rellena en caliente.
   */
  telefono: string | null;
  contactName: string | undefined;
};

/**
 * jsonSchema se escribe a mano en paralelo a inputSchema (Zod) — se probó
 * `zod-to-json-schema` y no genera esquemas usables con Zod v4 (devuelve
 * `{}` para schemas reales), así que no hay forma automática de derivarlo
 * sin agregar una dependencia rota. Con 7 tools de 1-4 campos cada uno,
 * mantener ambos a mano es manejable; inputSchema sigue siendo la
 * validación real en runtime, jsonSchema es solo lo que ve Claude.
 */
export type AgentTool<TInput> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  jsonSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (input: TInput, ctx: AgentContext) => Promise<unknown>;
  /**
   * true si la tool escribe algo (agendar, cancelar, escalar…). En modo
   * `sugerir` (runner.ts) estas se excluyen de lo que Claude puede ver: una
   * sugerencia de respuesta nunca debe poder agendar ni cancelar nada por sí
   * sola. Sin esto (default false), la tool es de solo lectura.
   */
  mutates?: boolean;
};
