import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dentroDeHorario,
  nombreParaSaludo,
  parametrosPlantilla,
  renderCuerpo,
  unaPorClienta,
  valoresDe,
  type Variable,
} from "../src/reactivacion/reactivacionReglas.js";

// ─── Reglas puras ───────────────────────────────────────────────────────────

describe("nombreParaSaludo", () => {
  it("usa solo el primer nombre, bien escrito", () => {
    expect(nombreParaSaludo("MARÍA josé Quispe")).toBe("María");
    expect(nombreParaSaludo("  rosa  ")).toBe("Rosa");
    expect(nombreParaSaludo("Ana-Lucía Soto")).toBe("Ana");
  });

  it("cae al saludo neutro con nombres de perfil raros o vacíos", () => {
    expect(nombreParaSaludo("comienza ser tu misma ☺")).toBe("bella");
    expect(nombreParaSaludo("☺ Lucía")).toBe("bella");
    expect(nombreParaSaludo("123")).toBe("bella");
    expect(nombreParaSaludo("")).toBe("bella");
    expect(nombreParaSaludo(null)).toBe("bella");
    expect(nombreParaSaludo("A")).toBe("bella");
  });
});

describe("armado del mensaje", () => {
  const variables: Variable[] = ["nombre", "servicio", "oferta", "codigo"];
  const valores = valoresDe({ clienteNombre: "lucia perez", servicio: "Esmaltado en gel", oferta: "10 % de descuento", codigo: "UNAS10" });

  it("rellena los {{n}} en el orden de las variables", () => {
    expect(renderCuerpo("Hola {{1}} ({{2}}): {{3}} con {{4}}.", variables, valores)).toBe(
      "Hola Lucia (Esmaltado en gel): 10 % de descuento con UNAS10.",
    );
  });

  it("respeta un orden distinto de variables", () => {
    expect(renderCuerpo("{{1}} / {{2}}", ["codigo", "nombre"], valores)).toBe("UNAS10 / Lucia");
  });

  it("deja intacto un {{n}} sin variable en vez de inventar texto", () => {
    expect(renderCuerpo("Hola {{9}}", variables, valores)).toBe("Hola {{9}}");
  });

  it("da los parámetros de la plantilla en orden", () => {
    expect(parametrosPlantilla(variables, valores)).toEqual(["Lucia", "Esmaltado en gel", "10 % de descuento", "UNAS10"]);
  });

  it("no manda un parámetro vacío: Meta lo rechazaría", () => {
    const sinCodigo = valoresDe({ clienteNombre: "Lucia", servicio: "Gel", oferta: "10 %", codigo: "  " });
    expect(() => parametrosPlantilla(variables, sinCodigo)).toThrow(/codigo/);
  });
});

describe("dentroDeHorario (hora de Lima)", () => {
  // Lima es UTC-5 todo el año.
  const limaA = (hora: number) => new Date(Date.UTC(2026, 9, 9, hora + 5, 30));

  it("deja escribir dentro del horario", () => {
    expect(dentroDeHorario(limaA(10), 10, 20)).toBe(true);
    expect(dentroDeHorario(limaA(19), 10, 20)).toBe(true);
  });

  it("no escribe de madrugada ni de noche", () => {
    expect(dentroDeHorario(limaA(3), 10, 20)).toBe(false);
    expect(dentroDeHorario(limaA(9), 10, 20)).toBe(false);
    expect(dentroDeHorario(limaA(20), 10, 20)).toBe(false);
    expect(dentroDeHorario(limaA(23), 10, 20)).toBe(false);
  });

  it("la medianoche de Lima no se confunde con la hora 24", () => {
    expect(dentroDeHorario(new Date(Date.UTC(2026, 9, 10, 5, 10)), 0, 24)).toBe(true);
  });
});

describe("unaPorClienta", () => {
  it("conserva la primera regla de cada clienta y el orden", () => {
    const filas = [
      { cliente_id: "a", regla: "color" },
      { cliente_id: "b", regla: "uñas" },
      { cliente_id: "a", regla: "general" },
    ];
    expect(unaPorClienta(filas)).toEqual([
      { cliente_id: "a", regla: "color" },
      { cliente_id: "b", regla: "uñas" },
    ]);
  });
});

// ─── El envío, con la base y WhatsApp simulados ─────────────────────────────

vi.mock("../src/config/env.js", () => ({ env: { WHATSAPP_TEMPLATE_LANG: "es", LOG_LEVEL: "silent" } }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const sendText = vi.fn();
const sendTemplate = vi.fn();
vi.mock("../src/whatsapp/client.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
}));

const isWindowOpenFor = vi.fn();
vi.mock("../src/whatsapp/window.js", () => ({ isWindowOpenFor: (...a: unknown[]) => isWindowOpenFor(...a) }));

const getOrCreateConversacionAbierta = vi.fn();
vi.mock("../src/db/repositories/conversaciones.js", () => ({
  getOrCreateConversacionAbierta: (...a: unknown[]) => getOrCreateConversacionAbierta(...a),
}));

const guardarMensaje = vi.fn();
vi.mock("../src/db/repositories/mensajes.js", () => ({ guardarMensaje: (...a: unknown[]) => guardarMensaje(...a) }));

type Fila = Record<string, unknown>;
const bd = {
  config: null as Fila | null,
  errorConfig: null as unknown,
  candidatas: [] as Fila[],
  errorInsert: null as { code: string } | null,
  inserts: [] as Fila[],
  updates: [] as { valores: Fila; id: unknown }[],
};

vi.mock("../src/db/client.js", () => ({
  supabase: {
    from(tabla: string) {
      if (tabla === "reactivacion_config") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: bd.config, error: bd.errorConfig }) }) }) };
      }
      return {
        insert: (fila: Fila) => {
          bd.inserts.push(fila);
          return { select: () => ({ single: async () => (bd.errorInsert ? { data: null, error: bd.errorInsert } : { data: { id: "reserva-1" }, error: null }) }) };
        },
        update: (valores: Fila) => ({
          eq: async (_col: string, id: unknown) => {
            bd.updates.push({ valores, id });
            return { error: null };
          },
        }),
      };
    },
    rpc: async () => ({ data: bd.candidatas, error: null }),
  },
}));

const { enviarReactivaciones } = await import("../src/reactivacion/reactivacion.js");

const DENTRO = new Date(Date.UTC(2026, 9, 9, 20, 0)); // 3 p. m. en Lima
const FUERA = new Date(Date.UTC(2026, 9, 9, 8, 0)); //   3 a. m. en Lima

const candidata = (extra: Fila = {}): Fila => ({
  regla_id: "regla-1",
  regla_nombre: "Uñas · a los 15 días",
  plantilla: "vuelve_aura",
  cuerpo: "Hola {{1}} 💛 ({{2}}): {{3}} con el código {{4}}.",
  variables: ["nombre", "servicio", "oferta", "codigo"],
  oferta: "10 % de descuento",
  codigo: "UNAS10",
  cliente_id: "cliente-1",
  cliente_nombre: "lucia",
  cliente_telefono: "51987654321",
  cita_id: "cita-1",
  servicio: "Esmaltado en gel",
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  bd.config = { activa: true, max_por_vuelta: 25, hora_desde: 10, hora_hasta: 20 };
  bd.errorConfig = null;
  bd.candidatas = [candidata()];
  bd.errorInsert = null;
  bd.inserts = [];
  bd.updates = [];
  isWindowOpenFor.mockResolvedValue(false);
  sendTemplate.mockResolvedValue("wamid.TEMPLATE");
  sendText.mockResolvedValue("wamid.TEXTO");
  getOrCreateConversacionAbierta.mockResolvedValue({ id: "conv-1" });
  guardarMensaje.mockResolvedValue({ id: "msg-1" });
});

describe("enviarReactivaciones", () => {
  it("no manda NADA si el interruptor general está apagado", async () => {
    bd.config = { activa: false, max_por_vuelta: 25, hora_desde: 10, hora_hasta: 20 };
    await enviarReactivaciones(DENTRO);
    expect(bd.inserts).toHaveLength(0);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("no manda si la migración no está (la tabla no existe)", async () => {
    bd.config = null;
    bd.errorConfig = { code: "42P01" };
    await enviarReactivaciones(DENTRO);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("no manda de madrugada", async () => {
    await enviarReactivaciones(FUERA);
    expect(bd.inserts).toHaveLength(0);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("fuera de las 24 h manda la plantilla con los parámetros en orden y lo anota", async () => {
    await enviarReactivaciones(DENTRO);

    expect(sendTemplate).toHaveBeenCalledWith({
      to: "51987654321",
      plantilla: "vuelve_aura",
      idioma: "es",
      parametros: ["Lucia", "Esmaltado en gel", "10 % de descuento", "UNAS10"],
    });
    expect(sendText).not.toHaveBeenCalled();

    // Se reservó antes de enviar y quedó como enviada.
    expect(bd.inserts[0]).toMatchObject({ cliente_id: "cliente-1", regla_id: "regla-1", cita_origen_id: "cita-1", oferta: "10 % de descuento", codigo: "UNAS10" });
    expect(bd.updates.at(-1)?.valores).toMatchObject({ estado: "enviada" });

    // Y quedó en el chat de ella, con lo que se le ofreció.
    expect(guardarMensaje).toHaveBeenCalledWith(
      expect.objectContaining({
        conversacionId: "conv-1",
        rol: "assistant",
        contenido: "Hola Lucia 💛 (Esmaltado en gel): 10 % de descuento con el código UNAS10.",
        metadata: { reactivacion: "regla-1", oferta: "10 % de descuento", codigo: "UNAS10" },
      }),
    );
  });

  it("dentro de las 24 h manda texto libre (gratis) en vez de plantilla", async () => {
    isWindowOpenFor.mockResolvedValue(true);
    await enviarReactivaciones(DENTRO);
    expect(sendText).toHaveBeenCalledWith("51987654321", "Hola Lucia 💛 (Esmaltado en gel): 10 % de descuento con el código UNAS10.");
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("si Meta rechaza el envío queda «fallida» con el motivo y NO se anota en el chat", async () => {
    sendTemplate.mockRejectedValue(new Error("Plantilla no aprobada"));
    await enviarReactivaciones(DENTRO);
    expect(bd.updates.at(-1)?.valores).toMatchObject({ estado: "fallida", error: "Plantilla no aprobada" });
    expect(guardarMensaje).not.toHaveBeenCalled();
  });

  it("un fallo en una clienta no frena a las demás", async () => {
    bd.candidatas = [candidata({ cliente_id: "c1", cliente_telefono: "51911111111" }), candidata({ cliente_id: "c2", cliente_telefono: "51922222222" })];
    sendTemplate.mockRejectedValueOnce(new Error("falló la primera")).mockResolvedValueOnce("wamid.OK");
    await enviarReactivaciones(DENTRO);
    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(bd.updates.filter((u) => u.valores.estado === "enviada")).toHaveLength(1);
  });

  it("si ya estaba reservada por otra vuelta (índice único) no manda nada", async () => {
    bd.errorInsert = { code: "23505" };
    await enviarReactivaciones(DENTRO);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("a una clienta con dos reglas a la vez le manda solo la primera", async () => {
    bd.candidatas = [candidata({ regla_id: "color-mes" }), candidata({ regla_id: "general-mes" })];
    await enviarReactivaciones(DENTRO);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(bd.inserts).toHaveLength(1);
    expect(bd.inserts[0]).toMatchObject({ regla_id: "color-mes" });
  });

  it("respeta el tope por vuelta", async () => {
    bd.config = { activa: true, max_por_vuelta: 2, hora_desde: 10, hora_hasta: 20 };
    bd.candidatas = ["a", "b", "c", "d"].map((c) => candidata({ cliente_id: c, cliente_telefono: `519${c}` }));
    await enviarReactivaciones(DENTRO);
    expect(sendTemplate).toHaveBeenCalledTimes(2);
  });

  it("si la regla no tiene código (parámetro vacío) falla esa clienta sin mandar algo roto", async () => {
    bd.candidatas = [candidata({ codigo: "" })];
    await enviarReactivaciones(DENTRO);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(bd.updates.at(-1)?.valores).toMatchObject({ estado: "fallida" });
  });

  it("que falle anotarlo en el chat no deshace el envío", async () => {
    guardarMensaje.mockRejectedValue(new Error("sin conexión"));
    await enviarReactivaciones(DENTRO);
    expect(bd.updates.at(-1)?.valores).toMatchObject({ estado: "enviada" });
  });
});
