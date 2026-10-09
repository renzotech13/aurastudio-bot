import { describe, expect, it } from "vitest";
import { PLANTILLAS_CAMPANIA, cuerpoPara, fueraDeFecha, nombreSaludo, plantillaPorClave } from "../src/campanias/plantillas.js";

const dia = (fecha: string) => new Date(`${fecha}T12:00:00-05:00`);

describe("plantillas de campaña: reglas de Meta", () => {
  for (const p of PLANTILLAS_CAMPANIA) {
    it(`${p.nombre} cumple las reglas`, () => {
      expect(p.nombre).toMatch(/^[a-z0-9_]+$/);
      const vars = [...p.cuerpo.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(p.ejemplos.length).toBe(vars.length ? Math.max(...vars) : 0);
      expect(p.cuerpo.trim().startsWith("{{")).toBe(false);
      expect(p.cuerpo.trim().endsWith("}}")).toBe(false);
      expect(p.cuerpo.length).toBeLessThanOrEqual(1024);
      for (const b of p.botones) expect(b.length).toBeLessThanOrEqual(25);
      if (p.pie) expect(p.pie.length).toBeLessThanOrEqual(60);
    });
  }

  it("las claves y los nombres no se repiten", () => {
    expect(new Set(PLANTILLAS_CAMPANIA.map((p) => p.clave)).size).toBe(PLANTILLAS_CAMPANIA.length);
    expect(new Set(PLANTILLAS_CAMPANIA.map((p) => p.nombre)).size).toBe(PLANTILLAS_CAMPANIA.length);
  });

  it("el recordatorio tiene las 3 variables que manda el bot", () => {
    const r = plantillaPorClave("recordatorio")!;
    expect(r.nombre).toBe("recordatorio_cita");
    expect(cuerpoPara(r, ["Ana", "Manicure", "lunes"])).toBe(
      "Hola Ana 💕 Te recordamos tu cita de Manicure el lunes en Aura Studio. Si necesitas reagendar o cancelar, respóndenos por acá.",
    );
  });
});

describe("ayudas", () => {
  it("saluda por el primer nombre o con «bella»", () => {
    expect(nombreSaludo("LUCÍA pérez")).toBe("Lucía");
    expect(nombreSaludo("✨ la más linda")).toBe("bella");
    expect(nombreSaludo(null)).toBe("bella");
  });

  it("respeta la ventana de envío de cada plantilla", () => {
    const ultimos = plantillaPorClave("halloween-ultimos-dias")!;
    expect(fueraDeFecha(ultimos, dia("2026-10-15"))).toMatch(/desde el 20 de octubre/);
    expect(fueraDeFecha(ultimos, dia("2026-10-21"))).toBeNull();
    expect(fueraDeFecha(ultimos, dia("2026-10-24"))).toMatch(/pasó/);
  });
});
