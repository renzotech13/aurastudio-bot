import { beforeEach, describe, expect, it, vi } from "vitest";

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

const getClienteByTelefono = vi.fn();
const guardarTelefonoCliente = vi.fn();
const guardarNombreCliente = vi.fn();
const guardarEmailCliente = vi.fn();
const fusionarClientes = vi.fn();
vi.mock("../src/db/repositories/clientes.js", () => ({
  getClienteByTelefono,
  guardarTelefonoCliente,
  guardarNombreCliente,
  guardarEmailCliente,
  fusionarClientes,
}));

const registrarEvento = vi.fn();
vi.mock("../src/db/repositories/eventos.js", () => ({ registrarEvento }));

const { guardarDatosContactoTool } = await import("../src/agent/tools/guardarDatosContacto.js");

function crearCtx(overrides: Partial<{ clienteId: string; telefono: string | null }> = {}) {
  return {
    canal: "instagram" as const,
    conversacionId: "conv-1",
    clienteId: overrides.clienteId ?? "cli-lead",
    telefono: overrides.telefono ?? null,
    contactName: undefined,
  };
}

beforeEach(() => {
  // Reset + resuelto por defecto: el handler llama `.catch()` sobre
  // guardarNombreCliente/guardarEmailCliente/registrarEvento (son
  // best-effort), y sobre un mock sin resolver eso revienta con
  // "Cannot read properties of undefined" en vez de simular una promesa real.
  getClienteByTelefono.mockReset().mockResolvedValue(null);
  guardarTelefonoCliente.mockReset().mockResolvedValue(undefined);
  guardarNombreCliente.mockReset().mockResolvedValue(undefined);
  guardarEmailCliente.mockReset().mockResolvedValue(undefined);
  fusionarClientes.mockReset().mockResolvedValue(undefined);
  registrarEvento.mockReset().mockResolvedValue(undefined);
});

describe("guardarDatosContactoTool — sin conflicto", () => {
  it("normaliza el teléfono y lo guarda directo en la misma clienta cuando nadie más lo tiene", async () => {
    getClienteByTelefono.mockResolvedValue(null);
    const ctx = crearCtx();

    const resultado = await guardarDatosContactoTool.handler({ telefono: "987654321" }, ctx);

    expect(resultado).toEqual({ ok: true });
    expect(guardarTelefonoCliente).toHaveBeenCalledWith("cli-lead", "51987654321");
    expect(fusionarClientes).not.toHaveBeenCalled();
    // El contexto se actualiza en caliente: las tools que se llamen después
    // en el mismo turno (agendar_cita, etc.) ya ven el teléfono.
    expect(ctx.telefono).toBe("51987654321");
    expect(ctx.clienteId).toBe("cli-lead");
  });

  it("acepta el teléfono ya con el 51 delante", async () => {
    getClienteByTelefono.mockResolvedValue(null);
    const ctx = crearCtx();
    await guardarDatosContactoTool.handler({ telefono: "51987654321" }, ctx);
    expect(guardarTelefonoCliente).toHaveBeenCalledWith("cli-lead", "51987654321");
  });

  it("un teléfono inválido no se guarda y devuelve un error instructivo", async () => {
    const ctx = crearCtx();
    const resultado = await guardarDatosContactoTool.handler({ telefono: "123" }, ctx);
    expect(resultado).toMatchObject({ ok: false, error: "telefono_invalido" });
    expect(guardarTelefonoCliente).not.toHaveBeenCalled();
    expect(getClienteByTelefono).not.toHaveBeenCalled();
  });

  it("nombre y correo se guardan sobre la clienta actual cuando no hay teléfono de por medio", async () => {
    const ctx = crearCtx();
    await guardarDatosContactoTool.handler({ nombre: "Rosita", email: "rosita@mail.com" }, ctx);
    expect(guardarNombreCliente).toHaveBeenCalledWith("cli-lead", "Rosita");
    expect(guardarEmailCliente).toHaveBeenCalledWith("cli-lead", "rosita@mail.com");
    expect(getClienteByTelefono).not.toHaveBeenCalled();
  });

  it("sin ningún dato, no hace nada y avisa", async () => {
    const ctx = crearCtx();
    const resultado = await guardarDatosContactoTool.handler({}, ctx);
    expect(resultado).toEqual({ ok: false, error: "sin_datos" });
  });
});

describe("guardarDatosContactoTool — el teléfono ya es de otra clienta", () => {
  it("fusiona el lead dentro de la clienta existente y actualiza ctx.clienteId/ctx.telefono", async () => {
    getClienteByTelefono.mockResolvedValue({ id: "cli-existente", telefono: "51987654321", nombre: "Rosa Quispe" });
    fusionarClientes.mockResolvedValue(undefined);
    const ctx = crearCtx({ clienteId: "cli-lead" });

    const resultado = await guardarDatosContactoTool.handler({ telefono: "987654321" }, ctx);

    expect(resultado).toEqual({ ok: true });
    // El origen es el lead (sin historial real todavía), el destino la clienta que ya tenía el número.
    expect(fusionarClientes).toHaveBeenCalledWith("cli-lead", "cli-existente");
    // No se llama guardarTelefonoCliente: fusionar_clientes ya deja el teléfono en el destino.
    expect(guardarTelefonoCliente).not.toHaveBeenCalled();
    expect(ctx.clienteId).toBe("cli-existente");
    expect(ctx.telefono).toBe("51987654321");
  });

  it("registra un evento de fusión en la conversación", async () => {
    getClienteByTelefono.mockResolvedValue({ id: "cli-existente", telefono: "51987654321", nombre: null });
    const ctx = crearCtx();
    await guardarDatosContactoTool.handler({ telefono: "987654321" }, ctx);
    expect(registrarEvento).toHaveBeenCalledWith("conv-1", "fusion", { origen: "cli-lead", destino: "cli-existente" });
  });

  it("nombre/correo dados en la misma llamada se aplican sobre la clienta GANADORA, no sobre el lead", async () => {
    getClienteByTelefono.mockResolvedValue({ id: "cli-existente", telefono: "51987654321", nombre: null });
    const ctx = crearCtx();

    await guardarDatosContactoTool.handler({ telefono: "987654321", nombre: "Rosa", email: "rosa@mail.com" }, ctx);

    expect(guardarNombreCliente).toHaveBeenCalledWith("cli-existente", "Rosa");
    expect(guardarEmailCliente).toHaveBeenCalledWith("cli-existente", "rosa@mail.com");
  });

  it("si el teléfono ya es de la MISMA clienta (ctx.clienteId), no fusiona consigo misma", async () => {
    getClienteByTelefono.mockResolvedValue({ id: "cli-lead", telefono: "51987654321", nombre: null });
    const ctx = crearCtx({ clienteId: "cli-lead" });

    await guardarDatosContactoTool.handler({ telefono: "987654321" }, ctx);

    expect(fusionarClientes).not.toHaveBeenCalled();
    expect(guardarTelefonoCliente).toHaveBeenCalledWith("cli-lead", "51987654321");
  });
});
