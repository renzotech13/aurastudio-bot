import { describe, expect, it } from "vitest";
import { promocionesVigentes, textoPromociones } from "../src/config/promociones.js";
import { anotarAnuncio, parseInboundMessages } from "../src/whatsapp/parser.js";

// Mediodía en Lima (UTC-5) del día indicado.
const dia = (fecha: string) => new Date(`${fecha}T12:00:00-05:00`);

describe("promociones", () => {
  it("antes de anunciarse no hay promo", () => {
    expect(promocionesVigentes(dia("2026-10-07"))).toHaveLength(0);
    expect(textoPromociones(dia("2026-10-07"))).not.toContain("Halloween");
  });

  it("se anuncia antes de regir: avisa que es reserva anticipada", () => {
    expect(promocionesVigentes(dia("2026-10-09")).map((p) => p.clave)).toEqual(["halloween-2026"]);
    const t = textoPromociones(dia("2026-10-09"));
    expect(t).toContain("Halloween");
    expect(t).toContain("Todavía NO rige");
  });

  it("rige entre desde y hasta (incluido el último día)", () => {
    expect(textoPromociones(dia("2026-10-15"))).toContain("Rige hoy");
    expect(promocionesVigentes(dia("2026-10-23"))).toHaveLength(1);
    expect(promocionesVigentes(dia("2026-10-24"))).toHaveLength(0);
  });
});

describe("anotarAnuncio", () => {
  it("sin referral deja el texto igual", () => {
    expect(anotarAnuncio("Hola")).toBe("Hola");
  });

  it("agrega título y texto del anuncio", () => {
    expect(anotarAnuncio("Hola, quiero más información", { headline: "Pestañas a S/ 20", body: "Con tu servicio" })).toBe(
      'Hola, quiero más información\n\n(Llegó desde un anuncio de Meta: "Pestañas a S/ 20 — Con tu servicio")',
    );
  });

  it("referral vacío igual marca que vino de un anuncio", () => {
    expect(anotarAnuncio("Hola", {})).toBe("Hola\n\n(Llegó desde un anuncio de Meta)");
  });

  it("el parser lee el referral del webhook", () => {
    const [m] = parseInboundMessages({
      object: "whatsapp_business_account",
      entry: [{ id: "e", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp", metadata: { phone_number_id: "1" },
        messages: [{ from: "51999", id: "w1", timestamp: "1", type: "text", text: { body: "Hola" },
          referral: { headline: "Halloween", body: "Pestañas", source_id: "120", source_type: "ad" } }],
      } }] }],
    });
    expect(m).toMatchObject({ kind: "text", text: 'Hola\n\n(Llegó desde un anuncio de Meta: "Halloween — Pestañas")' });
  });
});
