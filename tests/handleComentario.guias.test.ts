import { beforeEach, describe, expect, it, vi } from "vitest";

// handleComentario junta muchas dependencias con base de datos y con Meta: acá
// se simulan todas para probar SOLO el cableado — que un comentario con la
// palabra clave termine mandando la guía por la respuesta privada, y que el
// resto se comporte como antes.
const responderComentarioPrivado = vi.fn();
const guardarMensaje = vi.fn();
const actualizarMetadataPorExternalId = vi.fn();
const registrarEvento = vi.fn();
const getCanalConfig = vi.fn();

vi.mock("../src/lib/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("../src/meta/identidades.js", () => ({
  resolverIdentidad: vi.fn().mockResolvedValue({ cliente: { id: "cli-1" }, identidad: { id: "idn-1" } }),
  vincularIdentidadMensajeria: vi.fn().mockResolvedValue({ id: "idn-dm-1" }),
}));
vi.mock("../src/db/repositories/conversaciones.js", () => ({
  getOrCreateConversacionAbierta: vi.fn().mockResolvedValue({ id: "conv-1" }),
}));
vi.mock("../src/db/repositories/mensajes.js", () => ({
  guardarMensaje: (...a: unknown[]) => guardarMensaje(...a),
  actualizarMetadataPorExternalId: (...a: unknown[]) => actualizarMetadataPorExternalId(...a),
}));
vi.mock("../src/db/repositories/canales.js", () => ({ getCanalConfig: (...a: unknown[]) => getCanalConfig(...a) }));
vi.mock("../src/db/repositories/eventos.js", () => ({ registrarEvento: (...a: unknown[]) => registrarEvento(...a) }));
vi.mock("../src/meta/client.js", () => ({
  responderComentarioPrivado: (...a: unknown[]) => responderComentarioPrivado(...a),
}));

const { handleComentario } = await import("../src/agent/handleComentario.js");

function comentario(texto: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "comentario_nuevo" as const,
    canal: "instagram" as const,
    cuentaId: "IG_ID_TEST",
    externalId: "comment_ig_1",
    remitenteId: "USER_IG_1",
    nombrePerfil: "rosita_ig",
    timestamp: new Date(),
    texto,
    hiloExterno: "MEDIA_9",
    parentId: null,
    ...extra,
  };
}

const canalEncendido = {
  activo: true,
  ia_activa: true,
  ia_comentarios_activa: true,
  texto_respuesta_privada: "Gracias por comentar 🤎 te escribimos por privado.",
  cuenta_id: "IG_ID_TEST",
  cuenta_nombre: "Aura",
};

beforeEach(() => {
  vi.clearAllMocks();
  getCanalConfig.mockResolvedValue(canalEncendido);
  responderComentarioPrivado.mockResolvedValue({ messageId: "mid-1", recipientId: "IGSID_1" });
  registrarEvento.mockResolvedValue(undefined);
  actualizarMetadataPorExternalId.mockResolvedValue(undefined);
  guardarMensaje.mockResolvedValue(undefined);
});

describe("handleComentario — guías", () => {
  it("BALAYAGE: la respuesta privada es la guía, con su enlace", async () => {
    await handleComentario(comentario("BALAYAGE"));

    expect(responderComentarioPrivado).toHaveBeenCalledTimes(1);
    const arg = responderComentarioPrivado.mock.calls[0]![0] as { canal: string; commentId: string; texto: string };
    expect(arg.canal).toBe("instagram");
    expect(arg.commentId).toBe("comment_ig_1");
    expect(arg.texto).toContain("https://aurastudio.pe/guias/balayage");
    expect(arg.texto).not.toContain("te escribimos por privado");
  });

  it("deja registrado qué guía se mandó (metadata del comentario y evento)", async () => {
    await handleComentario(comentario("Balayage 🙋‍♀️"));

    expect(actualizarMetadataPorExternalId).toHaveBeenCalledWith("comment_ig_1", {
      respondido_privado: true,
      guia_enviada: "BALAYAGE",
    });
    expect(registrarEvento).toHaveBeenCalledWith("conv-1", "respuesta_privada", {
      comment_id: "comment_ig_1",
      guia: "BALAYAGE",
    });
  });

  it("guarda en la conversación de DM exactamente el texto que se mandó", async () => {
    await handleComentario(comentario("balayage"));

    const enviado = (responderComentarioPrivado.mock.calls[0]![0] as { texto: string }).texto;
    const guardado = guardarMensaje.mock.calls.map((c) => c[0] as { rol: string; contenido?: string });
    expect(guardado.some((m) => m.rol === "assistant" && m.contenido === enviado)).toBe(true);
  });

  it("un comentario cualquiera sigue recibiendo el texto fijo, sin guía ni metadata de guía", async () => {
    await handleComentario(comentario("Hermoso trabajo! cuánto cuesta?"));

    expect((responderComentarioPrivado.mock.calls[0]![0] as { texto: string }).texto).toBe(canalEncendido.texto_respuesta_privada);
    expect(actualizarMetadataPorExternalId).toHaveBeenCalledWith("comment_ig_1", { respondido_privado: true });
    expect(registrarEvento).toHaveBeenCalledWith("conv-1", "respuesta_privada", { comment_id: "comment_ig_1" });
  });

  it("con el interruptor de comentarios apagado no manda ni la guía", async () => {
    getCanalConfig.mockResolvedValue({ ...canalEncendido, ia_comentarios_activa: false });
    await handleComentario(comentario("BALAYAGE"));
    expect(responderComentarioPrivado).not.toHaveBeenCalled();
  });

  it("una respuesta anidada con la palabra clave no gasta la respuesta privada", async () => {
    await handleComentario(comentario("BALAYAGE", { parentId: "otro_comentario" }));
    expect(responderComentarioPrivado).not.toHaveBeenCalled();
  });

  it("si Meta rechaza el envío, no revienta ni registra la guía como enviada", async () => {
    responderComentarioPrivado.mockRejectedValue(new Error("meta_send_failed"));
    await expect(handleComentario(comentario("BALAYAGE"))).resolves.toBeUndefined();
    expect(registrarEvento).not.toHaveBeenCalled();
    expect(actualizarMetadataPorExternalId).not.toHaveBeenCalled();
  });
});
