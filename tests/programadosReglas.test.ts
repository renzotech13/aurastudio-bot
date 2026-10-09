import { describe, expect, it } from "vitest";
import { decidirProgramado, TOLERANCIA_ATRASO_MS } from "../src/seguimientos/programadosReglas.js";
import { estadoDeNuevaCita, estadoPermitido, inicioPermitido } from "../src/lib/vendedorReglas.js";

const hora = new Date("2026-10-10T21:30:00Z");
const minutos = (n: number) => new Date(hora.getTime() + n * 60_000);

describe("decidirProgramado", () => {
  it("manda un mensaje que le toca justo ahora", () => {
    expect(decidirProgramado({ ahora: hora, programadoPara: hora, cancelarSiResponde: true, escribioDespues: false })).toEqual({
      accion: "enviar",
    });
  });

  it("manda uno con unos minutos de atraso", () => {
    expect(decidirProgramado({ ahora: minutos(5), programadoPara: hora, cancelarSiResponde: true, escribioDespues: false }).accion).toBe(
      "enviar",
    );
  });

  it("no manda uno que se pasó por más de 2 horas (el bot estuvo caído)", () => {
    const tarde = new Date(hora.getTime() + TOLERANCIA_ATRASO_MS + 1);
    expect(decidirProgramado({ ahora: tarde, programadoPara: hora, cancelarSiResponde: false, escribioDespues: false }).accion).toBe(
      "fallido",
    );
  });

  it("en el límite exacto de 2 horas todavía lo manda", () => {
    const limite = new Date(hora.getTime() + TOLERANCIA_ATRASO_MS);
    expect(decidirProgramado({ ahora: limite, programadoPara: hora, cancelarSiResponde: false, escribioDespues: false }).accion).toBe(
      "enviar",
    );
  });

  it("se cancela si ella escribió y así se pidió", () => {
    expect(decidirProgramado({ ahora: hora, programadoPara: hora, cancelarSiResponde: true, escribioDespues: true }).accion).toBe(
      "cancelado",
    );
  });

  it("se manda igual si ella escribió pero no se pidió cancelar", () => {
    expect(decidirProgramado({ ahora: hora, programadoPara: hora, cancelarSiResponde: false, escribioDespues: true }).accion).toBe(
      "enviar",
    );
  });
});

describe("reglas del vendedor", () => {
  it("el vendedor solo confirma o cancela", () => {
    expect(estadoPermitido("vendedor", "confirmada")).toBe(true);
    expect(estadoPermitido("vendedor", "cancelada")).toBe(true);
    expect(estadoPermitido("vendedor", "completada")).toBe(false);
    expect(estadoPermitido("vendedor", "no_asistio")).toBe(false);
  });

  it("la administradora puede dejar cualquier estado", () => {
    for (const e of ["confirmada", "cancelada", "completada", "no_asistio"] as const) {
      expect(estadoPermitido("staff", e)).toBe(true);
    }
  });

  it("una cita creada por un vendedor siempre nace confirmada", () => {
    expect(estadoDeNuevaCita("vendedor", "completada")).toBe("confirmada");
    expect(estadoDeNuevaCita("vendedor", "confirmada")).toBe("confirmada");
  });

  it("la administradora conserva el estado que pidió", () => {
    expect(estadoDeNuevaCita("staff", "completada")).toBe("completada");
    expect(estadoDeNuevaCita("staff", "confirmada")).toBe("confirmada");
  });

  it("el vendedor no puede reservar en el pasado, pero sí «ahora»", () => {
    const ahora = new Date("2026-10-10T15:00:00Z");
    expect(inicioPermitido("vendedor", new Date("2026-10-10T14:50:00Z"), ahora)).toBe(true);
    expect(inicioPermitido("vendedor", new Date("2026-10-10T14:40:00Z"), ahora)).toBe(false);
    expect(inicioPermitido("vendedor", new Date("2026-10-09T10:00:00Z"), ahora)).toBe(false);
    expect(inicioPermitido("vendedor", new Date("2026-10-11T10:00:00Z"), ahora)).toBe(true);
  });

  it("la administradora puede anotar una atención de ayer", () => {
    expect(inicioPermitido("staff", new Date("2026-10-09T10:00:00Z"), new Date("2026-10-10T15:00:00Z"))).toBe(true);
  });
});
