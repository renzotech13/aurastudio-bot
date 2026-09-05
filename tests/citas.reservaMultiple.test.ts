import { beforeEach, describe, expect, it, vi } from "vitest";

// Regresión de la reserva de varios servicios.
//
// crearCitasConsecutivas encadena una cita por servicio, contiguas. Antes,
// al validar la cita 2, crearCita volvía a leer las citas del rango —donde
// ya estaba la cita 1 recién insertada— y le aplicaba BUFFER_MINUTES a
// ambos lados: la cita 1 [10:00, 11:00) se inflaba a [09:45, 11:15) y la
// cita 2, que arranca a las 11:00, chocaba siempre. Toda reserva de dos o
// más servicios fallaba.
//
// El colchón separa clientas distintas, no los servicios de una misma
// reserva. Aquí se comprueba eso sin tocar Supabase.

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

const SERVICIOS: Record<string, { id: string; name: string; duration_minutes: number }> = {
  "corte-dama": { id: "corte-dama", name: "Corte de dama", duration_minutes: 60 },
  "manicure-gel": { id: "manicure-gel", name: "Manicure en gel", duration_minutes: 60 },
};

vi.mock("../src/db/repositories/services.js", () => ({
  getServiceById: vi.fn(async (id: string) => SERVICIOS[id] ?? null),
}));

vi.mock("../src/db/repositories/clientes.js", () => ({
  getClienteById: vi.fn(async () => null),
}));

// Miércoles, abierto de 10:00 a 21:00 hora de Lima (migración 0005).
vi.mock("../src/db/repositories/businessHours.js", () => ({
  getBusinessHours: vi.fn(async () => [
    { weekday: 3, opensAt: "10:00", closesAt: "21:00" },
  ]),
}));

vi.mock("../src/db/repositories/bloqueos.js", () => ({
  getBloqueosEnRango: vi.fn(async () => []),
}));

vi.mock("../src/calendar/google.js", () => ({
  createCalendarEvent: vi.fn(async () => null),
  deleteCalendarEvent: vi.fn(async () => undefined),
}));

/**
 * Supabase de mentira con las citas en memoria: `select` sobre citas
 * devuelve lo insertado hasta ahora, que es justo lo que hacía fallar a la
 * segunda cita de la reserva.
 */
const citasEnMemoria: { id: string; inicio_utc: string; fin_utc: string; estado: string }[] = [];
let contador = 0;

vi.mock("../src/db/client.js", () => {
  const consulta = () => {
    const encadenable: Record<string, unknown> = {};
    for (const metodo of ["select", "neq", "lt", "gt", "eq", "update", "delete"]) {
      encadenable[metodo] = () => encadenable;
    }
    // Al await-earlo, resuelve con las citas vivas del rango.
    encadenable.then = (resolve: (v: unknown) => void) =>
      resolve({ data: citasEnMemoria.filter((c) => c.estado !== "cancelada"), error: null });
    encadenable.single = async () => ({ data: null, error: null });
    return encadenable;
  };

  return {
    supabase: {
      from: (tabla: string) => {
        if (tabla !== "citas") return consulta();
        const api = consulta();
        api.insert = (fila: Record<string, unknown>) => {
          contador += 1;
          const cita = {
            id: `cita-${contador}`,
            estado: "confirmada",
            google_event_id: null,
            notas: null,
            ...fila,
          };
          citasEnMemoria.push(cita as never);
          return { select: () => ({ single: async () => ({ data: cita, error: null }) }) };
        };
        return api;
      },
    },
  };
});

const { crearCitasConsecutivas } = await import("../src/db/repositories/citas.js");

describe("crearCitasConsecutivas — reserva de varios servicios", () => {
  beforeEach(() => {
    citasEnMemoria.length = 0;
    contador = 0;
  });

  it("agenda dos servicios contiguos sin que el colchón haga chocar al segundo", async () => {
    // Miércoles 10:00 de Lima = 15:00 UTC, bien lejos de la anticipación mínima.
    const inicioUtc = new Date("2027-03-10T15:00:00Z");

    const resultado = await crearCitasConsecutivas({
      clienteId: "cliente-1",
      servicioIds: ["corte-dama", "manicure-gel"],
      inicioUtc,
      creadaPor: "humano",
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.citas).toHaveLength(2);
    // La segunda arranca exactamente donde termina la primera.
    expect(resultado.citas[0].fin_utc).toBe(resultado.citas[1].inicio_utc);
  });

  it("sigue rechazando cuando el hueco lo ocupa una cita ajena a la reserva", async () => {
    citasEnMemoria.push({
      id: "cita-de-otra-clienta",
      inicio_utc: "2027-03-10T15:30:00Z",
      fin_utc: "2027-03-10T16:30:00Z",
      estado: "confirmada",
    });

    const resultado = await crearCitasConsecutivas({
      clienteId: "cliente-1",
      servicioIds: ["corte-dama"],
      inicioUtc: new Date("2027-03-10T15:00:00Z"),
      creadaPor: "humano",
    });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.reason).toBe("conflicto_horario");
  });
});
