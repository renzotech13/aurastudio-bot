import { describe, expect, it } from "vitest";
import { elegirHorarios, esImagenCompatible, etiquetaHorario, filaServicio, horaAmPm, recortar, textoDeOpcion } from "../src/whatsapp/formato.js";

describe("mensajes interactivos", () => {
  it("la fila de un servicio respeta los límites de WhatsApp", () => {
    const f = filaServicio({ id: "s1", name: "Uñas esculpidas con diseño francés extra largo", duration: "1 h 30 min", price: "100" });
    expect(f.id).toBe("servicio:s1");
    expect(f.descripcion).toBe("1 h 30 min · S/ 100");
    expect(recortar(f.titulo, 24).length).toBeLessThanOrEqual(24);
  });

  it("horarios en formato de Lima", () => {
    expect(horaAmPm("15:00")).toBe("3:00 p. m.");
    expect(horaAmPm("10:30")).toBe("10:30 a. m.");
    expect(horaAmPm("12:00")).toBe("12:00 p. m.");
    expect(etiquetaHorario("2026-10-10", "15:00", "2026-10-10")).toBe("Hoy 3:00 p. m.");
    expect(etiquetaHorario("2026-10-11", "11:00", "2026-10-10")).toBe("Mañana 11:00 a. m.");
    const otro = etiquetaHorario("2026-10-17", "11:00", "2026-10-10");
    expect(otro).toBe("Sáb 17 oct 11:00 a. m.");
    expect(otro.length).toBeLessThanOrEqual(24);
  });

  it("reparte los horarios en varios días y no pasa de 9", () => {
    const horas = ["10:00", "10:30", "11:00", "11:30", "12:00", "15:00", "16:00", "17:00", "18:00", "19:00"];
    const r = elegirHorarios([
      { fecha: "2026-10-10", horas },
      { fecha: "2026-10-11", horas: [] },
      { fecha: "2026-10-12", horas },
      { fecha: "2026-10-13", horas },
    ]);
    expect(r.length).toBe(9);
    expect(new Set(r.map((h) => h.fecha)).size).toBe(3);
    expect(r.filter((h) => h.fecha === "2026-10-10").length).toBeLessThanOrEqual(4);
  });

  it("solo JPG o PNG van como foto de la tarjeta", () => {
    expect(esImagenCompatible("https://x.supabase.co/storage/v1/object/public/a/unas.jpg")).toBe(true);
    expect(esImagenCompatible("https://x.co/a.PNG?v=2")).toBe(true);
    expect(esImagenCompatible("https://x.co/a.webp")).toBe(false);
    expect(esImagenCompatible(null)).toBe(false);
  });

  it("lo que toca llega al bot con su id", () => {
    expect(textoDeOpcion("Reservar", "reservar:s1")).toBe("Reservar\n\n(Tocó la opción «Reservar» · reservar:s1)");
  });

  it("los cuerpos conservan sus saltos de línea; los títulos van en una línea", () => {
    expect(recortar("*Uñas*\n1 h · S/ 65", 1024, false)).toBe("*Uñas*\n1 h · S/ 65");
    expect(recortar("a\nb", 24)).toBe("a b");
  });
});
