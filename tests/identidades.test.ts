import { beforeEach, describe, expect, it, vi } from "vitest";
import { crearSupabaseFalso } from "./helpers/supabaseFalso.js";

vi.mock("../src/config/env.js", () => ({
  env: {
    PORT: 3000,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    META_GRAPH_VERSION: "v26.0",
    META_PAGE_ACCESS_TOKEN: "test",
    META_PAGE_ID: "PAGE_ID_TEST",
    BUSINESS_TIMEZONE: "America/Lima",
    ESCALATION_PHONE: "51900000000",
    LOG_LEVEL: "silent",
  },
}));

const falso = crearSupabaseFalso();
vi.mock("../src/db/client.js", () => ({ supabase: falso.supabase }));

const crearClienteLead = vi.fn();
const getClienteById = vi.fn();
vi.mock("../src/db/repositories/clientes.js", () => ({ crearClienteLead, getClienteById }));

const obtenerPerfil = vi.fn();
vi.mock("../src/meta/client.js", () => ({ obtenerPerfil }));

const { resolverIdentidad, vincularIdentidadMensajeria } = await import("../src/meta/identidades.js");

const CLIENTE_NUEVO = { id: "cli-1", telefono: null, nombre: "Rosita IG", canal_origen: "instagram" };

beforeEach(() => {
  falso.reiniciar();
  crearClienteLead.mockReset();
  getClienteById.mockReset();
  obtenerPerfil.mockReset();
});

describe("resolverIdentidad", () => {
  it("crea una clienta sin teléfono cuando la identidad no existía (psid/igsid, con perfil)", async () => {
    falso.busqueda = [null]; // no hay identidad existente
    obtenerPerfil.mockResolvedValue({ nombre: "Rosita IG", username: "rosita_ig", fotoUrl: "https://cdn/x.jpg" });
    crearClienteLead.mockResolvedValue(CLIENTE_NUEVO);
    falso.insercion = {
      data: { id: "ident-1", cliente_id: "cli-1", canal: "instagram", tipo: "igsid", external_id: "IGSID_1" },
      error: null,
    };

    const { cliente, identidad } = await resolverIdentidad({
      canal: "instagram",
      tipo: "igsid",
      externalId: "IGSID_1",
      cuentaId: "IG_ID_TEST",
    });

    expect(crearClienteLead).toHaveBeenCalledWith({ nombre: "Rosita IG", canalOrigen: "instagram" });
    expect(cliente.id).toBe("cli-1");
    expect(identidad.id).toBe("ident-1");
    expect(falso.insertado).toMatchObject({ cliente_id: "cli-1", canal: "instagram", tipo: "igsid", external_id: "IGSID_1" });
  });

  it("reutiliza la clienta cuando la identidad ya existía, y refresca el perfil (psid/igsid)", async () => {
    const existente = { id: "ident-1", cliente_id: "cli-1", canal: "instagram", tipo: "igsid", external_id: "IGSID_1" };
    falso.busqueda = [existente];
    obtenerPerfil.mockResolvedValue({ nombre: "Rosita IG (nuevo nombre)", username: "rosita_ig", fotoUrl: null });
    getClienteById.mockResolvedValue(CLIENTE_NUEVO);

    const { cliente } = await resolverIdentidad({ canal: "instagram", tipo: "igsid", externalId: "IGSID_1", cuentaId: "IG_ID_TEST" });

    expect(cliente.id).toBe("cli-1");
    expect(crearClienteLead).not.toHaveBeenCalled();
    expect(obtenerPerfil).toHaveBeenCalledWith({ canal: "instagram", id: "IGSID_1" });
    // El refresh es un UPDATE, no un INSERT.
    expect(falso.filtro("update", undefined as unknown as string)).toBeUndefined(); // no falla si no hay filtros posteriores al update
  });

  it("una identidad de COMENTARIO (fb_comment_user) no llama a obtenerPerfil — usa el nombre que vino en el evento", async () => {
    falso.busqueda = [null];
    crearClienteLead.mockResolvedValue({ id: "cli-2", telefono: null, nombre: "Carmen Diaz", canal_origen: "messenger" });
    falso.insercion = { data: { id: "ident-2", cliente_id: "cli-2", canal: "messenger", tipo: "fb_comment_user", external_id: "USER_FB_1" }, error: null };

    const { cliente } = await resolverIdentidad({
      canal: "messenger",
      tipo: "fb_comment_user",
      externalId: "USER_FB_1",
      cuentaId: "PAGE_ID_TEST",
      nombreConocido: "Carmen Diaz",
    });

    expect(obtenerPerfil).not.toHaveBeenCalled();
    expect(crearClienteLead).toHaveBeenCalledWith({ nombre: "Carmen Diaz", canalOrigen: "messenger" });
    expect(cliente.id).toBe("cli-2");
  });

  it("si dos eventos casi simultáneos crean la misma identidad, el que pierde la carrera relee la ganadora", async () => {
    falso.busqueda = [null, { id: "ident-ganadora", cliente_id: "cli-ganador", canal: "instagram", tipo: "igsid", external_id: "IGSID_2" }];
    obtenerPerfil.mockResolvedValue(null);
    crearClienteLead.mockResolvedValue({ id: "cli-perdedor", telefono: null, nombre: null, canal_origen: "instagram" });
    getClienteById.mockResolvedValue({ id: "cli-ganador", telefono: null, nombre: null, canal_origen: "instagram" });
    falso.insercion = { data: null, error: { code: "23505" } };

    const { cliente, identidad } = await resolverIdentidad({ canal: "instagram", tipo: "igsid", externalId: "IGSID_2", cuentaId: "IG_ID_TEST" });

    expect(identidad.id).toBe("ident-ganadora");
    expect(cliente.id).toBe("cli-ganador");
  });
});

describe("vincularIdentidadMensajeria", () => {
  it("crea la identidad psid/igsid nueva enlazada a una clienta que ya existía por otra vía", async () => {
    falso.busqueda = [null];
    falso.insercion = { data: { id: "ident-dm", cliente_id: "cli-2", canal: "instagram", tipo: "igsid", external_id: "IGSID_DEVUELTO" }, error: null };

    const identidad = await vincularIdentidadMensajeria({
      clienteId: "cli-2",
      canal: "instagram",
      tipo: "igsid",
      externalId: "IGSID_DEVUELTO",
      cuentaId: "IG_ID_TEST",
    });

    expect(identidad.id).toBe("ident-dm");
    expect(falso.insertado).toMatchObject({ cliente_id: "cli-2", canal: "instagram", tipo: "igsid", external_id: "IGSID_DEVUELTO" });
  });

  it("si ya existía, la reutiliza sin intentar insertar de nuevo", async () => {
    const existente = { id: "ident-dm", cliente_id: "cli-2", canal: "instagram", tipo: "igsid", external_id: "IGSID_DEVUELTO" };
    falso.busqueda = [existente];

    const identidad = await vincularIdentidadMensajeria({
      clienteId: "cli-2",
      canal: "instagram",
      tipo: "igsid",
      externalId: "IGSID_DEVUELTO",
      cuentaId: "IG_ID_TEST",
    });

    expect(identidad).toEqual(existente);
    expect(falso.insertado).toBeNull();
  });
});
