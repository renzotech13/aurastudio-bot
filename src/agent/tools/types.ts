import type { z } from "zod";

/**
 * El teléfono nunca es un parámetro que el modelo pueda pasar — siempre
 * viene del contexto que inyecta el runner a partir del remitente real del
 * mensaje de WhatsApp. Así ningún tool puede tocar citas de otro número
 * aunque el modelo se equivoque o intente pasarlo distinto.
 */
export type AgentContext = {
  /**
   * Null en un lead de Instagram/Messenger que todavía no dio su número —
   * las tools que operan citas lo necesitan y deben devolver un error
   * instructivo en vez de asumir nada (ver el guard al inicio de cada una).
   */
  telefono: string | null;
  conversacionId: string;
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
};
