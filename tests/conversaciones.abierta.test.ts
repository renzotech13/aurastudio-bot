import { beforeEach, describe, expect, it, vi } from "vitest";
import { crearSupabaseFalso } from "./helpers/supabaseFalso.js";

// Mismo patrón que crm.test.ts: el módulo bajo prueba arrastra config/env.js,
// que valida process.env al cargarse.
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

const falso = crearSupabaseFalso();
vi.mock("../src/db/client.js", () => ({ supabase: falso.supabase }));

const { getOrCreateConversacionAbierta } = await import("../src/db/repositories/conversaciones.js");

const CONVERSACION_ESCALADA = {
  id: "conv-1",
  cliente_id: "cli-1",
  canal: "whatsapp",
  origen: "dm",
  estado: "escalada",
  etapa: "en_atencion",
};

beforeEach(() => falso.reiniciar());

describe("getOrCreateConversacionAbierta", () => {
  // ESTE es el bug: buscaba solo estado='activa', así que un mensaje que
  // llegaba a una conversación escalada abría otra en 'activa' y el bot
  // volvía a responder por encima de la persona que estaba atendiendo.
  it("busca por los dos estados abiertos, no solo por 'activa'", async () => {
    falso.busqueda = [CONVERSACION_ESCALADA];
    await getOrCreateConversacionAbierta({ clienteId: "cli-1" });

    expect(falso.filtro("in", "estado")?.args[1]).toEqual(["activa", "escalada"]);
  });

  it("reutiliza la conversación escalada en vez de abrir una nueva", async () => {
    falso.busqueda = [CONVERSACION_ESCALADA];

    const conversacion = await getOrCreateConversacionAbierta({ clienteId: "cli-1" });

    expect(conversacion.id).toBe("conv-1");
    expect(conversacion.estado).toBe("escalada");
    expect(falso.insertado).toBeNull();
  });

  it("crea una nueva si la última quedó cerrada", async () => {
    falso.busqueda = [null];
    falso.insercion = { data: { ...CONVERSACION_ESCALADA, id: "conv-2", estado: "activa" }, error: null };

    const conversacion = await getOrCreateConversacionAbierta({ clienteId: "cli-1" });

    expect(conversacion.id).toBe("conv-2");
    expect(falso.insertado).toMatchObject({ cliente_id: "cli-1", canal: "whatsapp", origen: "dm" });
  });

  it("separa el hilo de un comentario del de los DMs", async () => {
    falso.busqueda = [null];
    falso.insercion = { data: { ...CONVERSACION_ESCALADA, id: "conv-3" }, error: null };

    await getOrCreateConversacionAbierta({
      clienteId: "cli-1",
      canal: "instagram",
      origen: "comentario",
      identidadId: "ident-1",
      hiloExterno: "MEDIA_9",
      cuentaId: "CUENTA_IG",
    });

    expect(falso.filtro("eq", "canal")?.args[1]).toBe("instagram");
    expect(falso.filtro("eq", "origen")?.args[1]).toBe("comentario");
    expect(falso.filtro("eq", "hilo_externo")?.args[1]).toBe("MEDIA_9");
    expect(falso.insertado).toMatchObject({
      canal: "instagram",
      origen: "comentario",
      identidad_id: "ident-1",
      hilo_externo: "MEDIA_9",
      cuenta_id: "CUENTA_IG",
    });
  });

  it("busca hilo_externo IS NULL en los DMs, no un igual contra null", async () => {
    falso.busqueda = [CONVERSACION_ESCALADA];
    await getOrCreateConversacionAbierta({ clienteId: "cli-1" });

    // `eq('hilo_externo', null)` no encuentra nada en SQL: null nunca es igual
    // a null. Sin el `is`, cada mensaje de DM abriría una conversación nueva.
    expect(falso.filtro("is", "hilo_externo")?.args[1]).toBeNull();
    expect(falso.filtro("eq", "hilo_externo")).toBeUndefined();
  });

  it("si dos mensajes cruzan a la vez, relee la que ganó la carrera", async () => {
    // El índice único parcial de la 0017 rechaza la segunda inserción con
    // 23505; quien pierde no debe reventar, sino usar la que ya existe.
    falso.busqueda = [null, { ...CONVERSACION_ESCALADA, id: "conv-ganadora" }];
    falso.insercion = { data: null, error: { code: "23505" } };

    const conversacion = await getOrCreateConversacionAbierta({ clienteId: "cli-1" });

    expect(conversacion.id).toBe("conv-ganadora");
  });
});
