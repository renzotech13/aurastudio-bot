import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: {
    PORT: 3000,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    BUSINESS_TIMEZONE: "America/Lima",
    ESCALATION_PHONE: "51900000000",
    LOG_LEVEL: "silent",
  },
}));

const { getToolDefinitions } = await import("../src/agent/tools/index.js");

const TOOLS_QUE_MUTAN = ["agendar_cita", "reagendar_cita", "cancelar_cita", "escalar_a_humano", "enviar_multimedia", "guardar_datos_contacto"];
const TOOLS_DE_SOLO_LECTURA = ["consultar_servicios", "consultar_disponibilidad", "consultar_mis_citas"];

describe("getToolDefinitions", () => {
  it("modo 'responder' (default) incluye todas las tools", () => {
    const nombres = getToolDefinitions().map((t) => t.name);
    for (const t of [...TOOLS_QUE_MUTAN, ...TOOLS_DE_SOLO_LECTURA]) expect(nombres).toContain(t);
  });

  it("modo 'sugerir' excluye las tools que mutan — una sugerencia nunca puede agendar/cancelar/escalar por sí sola", () => {
    const nombres = getToolDefinitions("sugerir").map((t) => t.name);
    for (const t of TOOLS_QUE_MUTAN) expect(nombres).not.toContain(t);
  });

  it("modo 'sugerir' conserva las de solo lectura, para que la sugerencia use datos reales", () => {
    const nombres = getToolDefinitions("sugerir").map((t) => t.name);
    for (const t of TOOLS_DE_SOLO_LECTURA) expect(nombres).toContain(t);
  });
});
