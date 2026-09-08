import type Anthropic from "@anthropic-ai/sdk";
import type { AgentContext, AgentTool } from "./types.js";
import { consultarServiciosTool } from "./consultarServicios.js";
import { consultarDisponibilidadTool } from "./consultarDisponibilidad.js";
import { agendarCitaTool } from "./agendarCita.js";
import { consultarMisCitasTool } from "./consultarMisCitas.js";
import { reagendarCitaTool } from "./reagendarCita.js";
import { cancelarCitaTool } from "./cancelarCita.js";
import { escalarAHumanoTool } from "./escalarAHumano.js";
import { enviarMultimediaTool } from "./enviarMultimedia.js";
import { guardarDatosContactoTool } from "./guardarDatosContacto.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_TOOLS: AgentTool<any>[] = [
  consultarServiciosTool,
  consultarDisponibilidadTool,
  agendarCitaTool,
  consultarMisCitasTool,
  reagendarCitaTool,
  cancelarCitaTool,
  escalarAHumanoTool,
  enviarMultimediaTool,
  guardarDatosContactoTool,
];

export type ModoAgente = "responder" | "sugerir";

/**
 * En modo "sugerir" (borrador para que el staff revise) las tools que
 * escriben algo ni siquiera se le muestran a Claude — no es que confiemos
 * en que no las llame, es que físicamente no puede: no están en la lista
 * que ve.
 */
export function getToolDefinitions(modo: ModoAgente = "responder"): Anthropic.Tool[] {
  const tools = modo === "sugerir" ? ALL_TOOLS.filter((t) => !t.mutates) : ALL_TOOLS;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.jsonSchema,
  }));
}

export type ToolExecutionResult = { content: string; isError: boolean };

/**
 * Valida el input crudo del modelo contra el Zod schema del tool antes de
 * ejecutarlo. Un input inválido no revienta la conversación: se devuelve
 * como tool_result con isError, así Claude ve el motivo y puede reintentar
 * con datos correctos.
 */
export async function executeTool(name: string, rawInput: unknown, ctx: AgentContext): Promise<ToolExecutionResult> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { content: `Tool desconocida: ${name}`, isError: true };
  }

  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { content: `Input inválido: ${parsed.error.message}`, isError: true };
  }

  try {
    const result = await tool.handler(parsed.data, ctx);
    return { content: JSON.stringify(result), isError: false };
  } catch (err) {
    return { content: `Error ejecutando ${name}: ${(err as Error).message}`, isError: true };
  }
}
