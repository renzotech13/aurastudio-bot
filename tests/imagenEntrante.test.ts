import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent", RATE_LIMIT_MAX_PER_MINUTE: 100 } }));

const descargarMedia = vi.fn();
vi.mock("../src/whatsapp/client.js", () => ({ descargarMedia }));

const subirAdjunto = vi.fn();
vi.mock("../src/lib/adjuntos.js", () => ({ subirAdjunto }));

const guardarMensaje = vi.fn();
const marcarExternalId = vi.fn();
vi.mock("../src/db/repositories/mensajes.js", () => ({ guardarMensaje, marcarExternalId }));

const sendTextIfWindowOpen = vi.fn();
vi.mock("../src/whatsapp/window.js", () => ({ sendTextIfWindowOpen }));

const getCitaPendienteDeComprobante = vi.fn();
vi.mock("../src/db/repositories/citas.js", () => ({ getCitaPendienteDeComprobante, guardarComprobante: vi.fn() }));

const getOrCreateConversacionAbierta = vi.fn();
vi.mock("../src/db/repositories/conversaciones.js", () => ({ escalarConversacion: vi.fn(), getOrCreateConversacionAbierta }));
vi.mock("../src/db/repositories/clientes.js", () => ({ findOrCreateByPhone: vi.fn().mockResolvedValue({ id: "cli-1" }) }));
vi.mock("../src/db/client.js", () => ({ supabase: {} }));
vi.mock("../src/agent/paymentProof.js", () => ({ analizarComprobante: vi.fn() }));
vi.mock("../src/agent/handleInbound.js", () => ({ handleInbound: vi.fn() }));

const { guardarImagenEntrante } = await import("../src/agent/handleImageMessage.js");
const { handleInboundMessage } = await import("../src/agent/handleMessage.js");

const FOTO = {
  kind: "image" as const,
  id: "wamid.foto",
  from: "51999888777",
  timestamp: "1700000000",
  mediaId: "media-1",
  mimeType: "image/jpeg",
};
const CONVERSACION = { id: "conv-1", cliente_id: "cli-1", estado: "activa" } as never;
const BYTES = { buffer: Buffer.from("jpg"), mimeType: "image/jpeg" };

beforeEach(() => {
  vi.clearAllMocks();
  descargarMedia.mockResolvedValue(BYTES);
  subirAdjunto.mockResolvedValue("conv-1/123.jpg");
  guardarMensaje.mockResolvedValue({ id: "msg-1" });
  sendTextIfWindowOpen.mockResolvedValue("wamid.respuesta");
  marcarExternalId.mockResolvedValue(undefined);
});

describe("guardarImagenEntrante — la foto queda visible en el panel", () => {
  it("sube la foto a `adjuntos` y guarda el mensaje con media_path, tipo imagen y el texto que la acompaña", async () => {
    const imagen = await guardarImagenEntrante({ ...FOTO, caption: "quiero este diseño" }, CONVERSACION);

    expect(imagen).toBe(BYTES);
    expect(subirAdjunto).toHaveBeenCalledWith({ conversacionId: "conv-1", buffer: BYTES.buffer, mimeType: "image/jpeg" });
    expect(guardarMensaje).toHaveBeenCalledWith(
      expect.objectContaining({
        rol: "user",
        contenido: "[Imagen recibida] quiero este diseño",
        waMessageId: "wamid.foto",
        mediaType: "image",
        mediaPath: "conv-1/123.jpg",
      }),
    );
  });

  it("si la descarga falla guarda el mensaje igual, sin media_path y con el error", async () => {
    descargarMedia.mockRejectedValue(new Error("media caducada"));

    const imagen = await guardarImagenEntrante(FOTO, CONVERSACION);

    expect(imagen).toBeNull();
    const guardado = guardarMensaje.mock.calls[0]![0];
    expect(guardado).toMatchObject({ contenido: "[Imagen recibida]", mediaType: "image" });
    expect(guardado.mediaPath).toBeUndefined();
    expect(guardado.metadata.error_descarga).toBe("media caducada");
  });
});

describe("handleInboundMessage con una foto", () => {
  it("con una persona atendiendo, la foto se guarda en el chat pero el bot no contesta", async () => {
    getOrCreateConversacionAbierta.mockResolvedValue({ id: "conv-1", cliente_id: "cli-1", estado: "escalada" });

    await handleInboundMessage(FOTO);

    expect(guardarMensaje).toHaveBeenCalledTimes(1);
    expect(guardarMensaje).toHaveBeenCalledWith(expect.objectContaining({ mediaPath: "conv-1/123.jpg" }));
    expect(getCitaPendienteDeComprobante).not.toHaveBeenCalled();
    expect(sendTextIfWindowOpen).not.toHaveBeenCalled();
  });

  it("sin comprobante pendiente, guarda la foto y responde, bajándola una sola vez", async () => {
    getOrCreateConversacionAbierta.mockResolvedValue({ id: "conv-1", cliente_id: "cli-1", estado: "activa" });
    getCitaPendienteDeComprobante.mockResolvedValue(null);

    await handleInboundMessage(FOTO);

    expect(descargarMedia).toHaveBeenCalledTimes(1);
    expect(guardarMensaje.mock.calls.map((c) => c[0].rol)).toEqual(["user", "assistant"]);
    expect(sendTextIfWindowOpen).toHaveBeenCalledTimes(1);
  });
});
