import { describe, expect, it } from "vitest";
import { calcularVentanaMeta } from "../src/meta/window.js";

describe("calcularVentanaMeta", () => {
  const ahora = new Date("2026-09-08T12:00:00.000Z");
  const hace = (horas: number) => new Date(ahora.getTime() - horas * 60 * 60_000);

  it("23h → RESPONSE (dentro de la ventana normal, cualquiera puede responder)", () => {
    const estado = calcularVentanaMeta({ ultimoMensajeAt: hace(23), rol: "assistant", humanAgentAprobado: false, ahora });
    expect(estado).toEqual({ abierta: true, modo: "RESPONSE" });
  });

  it("25h con Human Agent aprobado y responde un humano → HUMAN_AGENT", () => {
    const estado = calcularVentanaMeta({ ultimoMensajeAt: hace(25), rol: "humano", humanAgentAprobado: true, ahora });
    expect(estado).toEqual({ abierta: true, modo: "HUMAN_AGENT" });
  });

  it("25h y responde el bot → cerrada, aunque Human Agent esté aprobado (el bot nunca usa ese tag)", () => {
    const estado = calcularVentanaMeta({ ultimoMensajeAt: hace(25), rol: "assistant", humanAgentAprobado: true, ahora });
    expect(estado.abierta).toBe(false);
  });

  it("25h, humano, pero Human Agent NO aprobado → cerrada", () => {
    const estado = calcularVentanaMeta({ ultimoMensajeAt: hace(25), rol: "humano", humanAgentAprobado: false, ahora });
    expect(estado.abierta).toBe(false);
  });

  it("8 días → cerrada, aunque sea humano con Human Agent aprobado", () => {
    const estado = calcularVentanaMeta({ ultimoMensajeAt: hace(24 * 8), rol: "humano", humanAgentAprobado: true, ahora });
    expect(estado.abierta).toBe(false);
  });

  it("sin mensajes entrantes (null) → cerrada", () => {
    const estado = calcularVentanaMeta({ ultimoMensajeAt: null, rol: "assistant", humanAgentAprobado: false, ahora });
    expect(estado.abierta).toBe(false);
  });

  it("justo en el límite de 24h (no menos) ya no es RESPONSE", () => {
    const limite = new Date(ahora.getTime() - 24 * 60 * 60_000);
    const estado = calcularVentanaMeta({ ultimoMensajeAt: limite, rol: "assistant", humanAgentAprobado: false, ahora });
    expect(estado.abierta).toBe(false);
  });
});
