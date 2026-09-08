import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: {
    PORT: 3000,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    META_GRAPH_VERSION: "v26.0",
    META_PAGE_ACCESS_TOKEN: "token-test",
    META_PAGE_ID: "PAGE_ID_TEST",
    META_IG_ACCOUNT_ID: "IG_ID_TEST",
    BUSINESS_TIMEZONE: "America/Lima",
    ESCALATION_PHONE: "51900000000",
    LOG_LEVEL: "silent",
  },
}));

const upsertMetricasContenidoDia = vi.fn();
vi.mock("../src/db/repositories/metricasContenido.js", () => ({ upsertMetricasContenidoDia }));

const { barrerMetricasContenido } = await import("../src/meta/insights.js");

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

beforeEach(() => {
  upsertMetricasContenidoDia.mockReset();
  upsertMetricasContenidoDia.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("barrerMetricasContenido", () => {
  it("guarda alcance, interacciones y seguidores cuando Meta responde bien", async () => {
    const fetchFalso = vi.fn((url: string) => {
      if (url.includes("PAGE_ID_TEST?fields=followers_count")) return Promise.resolve(jsonResponse({ followers_count: 812 }));
      if (url.includes("PAGE_ID_TEST/insights")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              { name: "page_views_total", values: [{ value: 120 }] },
              { name: "page_post_engagements", values: [{ value: 34 }] },
            ],
          }),
        );
      }
      if (url.includes("IG_ID_TEST?fields=followers_count")) return Promise.resolve(jsonResponse({ followers_count: 1500 }));
      if (url.includes("IG_ID_TEST/insights?metric=reach")) {
        return Promise.resolve(jsonResponse({ data: [{ name: "reach", values: [{ value: 300 }] }] }));
      }
      if (url.includes("IG_ID_TEST/insights?metric=views")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              { name: "views", total_value: { value: 900 } },
              { name: "accounts_engaged", total_value: { value: 45 } },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, false));
    });
    vi.stubGlobal("fetch", fetchFalso);

    await barrerMetricasContenido();

    expect(upsertMetricasContenidoDia).toHaveBeenCalledTimes(2);
    const [canalFb, fechaFb, datosFb] = upsertMetricasContenidoDia.mock.calls[0];
    expect(canalFb).toBe("facebook");
    expect(fechaFb).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(datosFb).toMatchObject({ alcance: 120, interacciones: 34, seguidores: 812, impresiones: null });

    const [canalIg, , datosIg] = upsertMetricasContenidoDia.mock.calls[1];
    expect(canalIg).toBe("instagram");
    expect(datosIg).toMatchObject({ alcance: 300, impresiones: 900, interacciones: 45, seguidores: 1500 });
  });

  it("guarda lo que sí obtuvo cuando Meta rechaza un metric puntual, sin tumbar el resto", async () => {
    const fetchFalso = vi.fn((url: string) => {
      if (url.includes("fields=followers_count")) return Promise.resolve(jsonResponse({ followers_count: 100 }));
      // Insights: Meta devuelve error para todo (simula un metric deprecado, ej. page_impressions).
      return Promise.resolve(jsonResponse({ error: { message: "Invalid metric" } }, false));
    });
    vi.stubGlobal("fetch", fetchFalso);

    await barrerMetricasContenido();

    expect(upsertMetricasContenidoDia).toHaveBeenCalledTimes(2);
    const [, , datosFb] = upsertMetricasContenidoDia.mock.calls[0];
    expect(datosFb).toMatchObject({ alcance: null, interacciones: null, seguidores: 100 });
  });

  it("no llama a Meta si no hay token de página configurado", async () => {
    vi.resetModules();
    vi.doMock("../src/config/env.js", () => ({
      env: {
        LOG_LEVEL: "silent",
        META_PAGE_ACCESS_TOKEN: undefined,
        META_PAGE_ID: undefined,
        META_IG_ACCOUNT_ID: undefined,
      },
    }));
    const fetchFalso = vi.fn();
    vi.stubGlobal("fetch", fetchFalso);

    const { barrerMetricasContenido: barrerSinToken } = await import("../src/meta/insights.js");
    await barrerSinToken();

    expect(fetchFalso).not.toHaveBeenCalled();
    vi.doUnmock("../src/config/env.js");
  });
});
