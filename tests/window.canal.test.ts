import { beforeEach, describe, expect, it, vi } from "vitest";
import { crearSupabaseFalso } from "./helpers/supabaseFalso.js";

vi.mock("../src/config/env.js", () => ({
  env: {
    PORT: 3000,
    WHATSAPP_VERIFY_TOKEN: "test",
    WHATSAPP_APP_SECRET: "test",
    WHATSAPP_ACCESS_TOKEN: "test",
    WHATSAPP_PHONE_NUMBER_ID: "test",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    BUSINESS_TIMEZONE: "America/Lima",
    ESCALATION_PHONE: "51900000000",
    LOG_LEVEL: "silent",
  },
}));

const falso = crearSupabaseFalso();
vi.mock("../src/db/client.js", () => ({ supabase: falso.supabase }));

const { getLastInboundAt } = await import("../src/whatsapp/window.js");

beforeEach(() => falso.reiniciar());

describe("getLastInboundAt", () => {
  /**
   * El bug: la consulta resolvía la conversación más reciente del cliente sin
   * mirar el canal. En cuanto la misma persona tuviera un DM de Instagram o
   * Messenger, ese mensaje "abría" la ventana de WhatsApp, el bot mandaba
   * texto libre a un número que llevaba días callado, y Meta lo rechazaba con
   * el error 131047.
   */
  it("solo mira conversaciones de WhatsApp", async () => {
    falso.busqueda = [{ ultimo_mensaje_at: "2026-09-08T10:00:00.000Z" }];

    await getLastInboundAt("51987654321");

    expect(falso.filtro("eq", "canal")?.args[1]).toBe("whatsapp");
    expect(falso.filtro("eq", "clientes.telefono")?.args[1]).toBe("51987654321");
  });

  it("devuelve null si ese número nunca escribió por WhatsApp", async () => {
    falso.busqueda = [null];
    expect(await getLastInboundAt("51987654321")).toBeNull();
  });

  it("devuelve la fecha del último entrante", async () => {
    falso.busqueda = [{ ultimo_mensaje_at: "2026-09-08T10:00:00.000Z" }];
    expect(await getLastInboundAt("51987654321")).toEqual(new Date("2026-09-08T10:00:00.000Z"));
  });
});
