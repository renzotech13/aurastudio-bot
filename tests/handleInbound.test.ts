import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent" } }));

const guardarMensaje = vi.fn();
vi.mock("../src/db/repositories/mensajes.js", () => ({ guardarMensaje }));

const escalarConversacion = vi.fn();
vi.mock("../src/db/repositories/conversaciones.js", () => ({ escalarConversacion }));

const getCanalConfig = vi.fn();
vi.mock("../src/db/repositories/canales.js", () => ({ getCanalConfig }));

const enviarTexto = vi.fn();
vi.mock("../src/canales/index.js", () => ({ getCanalAdapter: () => ({ enviarTexto }) }));

const runAgent = vi.fn();
vi.mock("../src/agent/runner.js", () => ({ runAgent, FALLBACK_MESSAGE: "No pude procesar tu mensaje, un asesor te va a escribir." }));

const { handleInbound } = await import("../src/agent/handleInbound.js");

const CONVERSACION = { id: "conv-1", cliente_id: "cli-1", estado: "activa" } as never;

const PARAMS_BASE = {
  conversacion: CONVERSACION,
  canal: "instagram" as const,
  destinatarioId: "igsid-1",
  telefono: null,
  contactName: undefined,
  texto: "Hola",
  externalId: "mid-1",
};

beforeEach(() => {
  guardarMensaje.mockReset().mockResolvedValue({ id: "msg-2" });
  escalarConversacion.mockReset();
  getCanalConfig.mockReset().mockResolvedValue({ activo: true, ia_activa: true });
  enviarTexto.mockReset();
  runAgent.mockReset().mockResolvedValue("¡Hola! ¿En qué te ayudo?");
});

describe("handleInbound — orden de envío y guardado de la respuesta del bot", () => {
  it("guarda el mensaje entrante primero, sin importar si el canal responde", async () => {
    getCanalConfig.mockResolvedValue({ activo: false, ia_activa: true });
    await handleInbound(PARAMS_BASE);

    expect(guardarMensaje).toHaveBeenCalledTimes(1);
    expect(guardarMensaje).toHaveBeenCalledWith(
      expect.objectContaining({ rol: "user", contenido: "Hola", externalId: "mid-1" }),
    );
  });

  it("cuando el envío tiene éxito, guarda la respuesta con external_id y sin error_entrega", async () => {
    enviarTexto.mockResolvedValue({ externalId: "mid-respuesta" });

    await handleInbound(PARAMS_BASE);

    expect(enviarTexto).toHaveBeenCalledTimes(1);
    const llamadaRespuesta = guardarMensaje.mock.calls.find((c) => c[0].rol === "assistant")!;
    expect(llamadaRespuesta[0]).toMatchObject({ externalId: "mid-respuesta" });
    expect(llamadaRespuesta[0].errorEntrega).toBeUndefined();
  });

  it("cuando Meta tira una excepción al enviar, NO deja el mensaje como si hubiera llegado", async () => {
    enviarTexto.mockRejectedValue(new Error("meta_api_failed: unknown error"));

    await handleInbound(PARAMS_BASE);

    // La llamada de envío se intentó ANTES de guardar la respuesta — es la
    // regla del proyecto ("enviar primero, guardar después"), y es lo que
    // permite que el guardado ya sepa si hubo que marcar error_entrega.
    const ordenEnvio = enviarTexto.mock.invocationCallOrder[0];
    const ordenGuardadoRespuesta = guardarMensaje.mock.invocationCallOrder[1];
    expect(ordenEnvio).toBeLessThan(ordenGuardadoRespuesta);

    const llamadaRespuesta = guardarMensaje.mock.calls.find((c) => c[0].rol === "assistant")!;
    expect(llamadaRespuesta[0].externalId).toBeUndefined();
    expect(llamadaRespuesta[0].errorEntrega).toContain("meta_api_failed");
  });

  it("cuando la ventana está cerrada (sin excepción), guarda error_entrega con el motivo", async () => {
    enviarTexto.mockResolvedValue({ externalId: null, motivoCierre: "Ventana de 24h cerrada" });

    await handleInbound(PARAMS_BASE);

    const llamadaRespuesta = guardarMensaje.mock.calls.find((c) => c[0].rol === "assistant")!;
    expect(llamadaRespuesta[0].externalId).toBeUndefined();
    expect(llamadaRespuesta[0].errorEntrega).toBe("Ventana de 24h cerrada");
  });

  it("no guarda ni intenta enviar respuesta si la conversación está escalada", async () => {
    await handleInbound({ ...PARAMS_BASE, conversacion: { ...CONVERSACION, estado: "escalada" } as never });

    expect(guardarMensaje).toHaveBeenCalledTimes(1); // solo el mensaje entrante
    expect(enviarTexto).not.toHaveBeenCalled();
  });
});
