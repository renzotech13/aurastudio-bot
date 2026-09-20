import { describe, expect, it } from "vitest";
import { GUIAS, MAX_PALABRAS_COMENTARIO_CLAVE, buscarGuia, mensajeGuia } from "../src/config/guias.js";
import { elegirRespuestaPrivada, type ConfigRespuestaPrivada } from "../src/agent/respuestaPrivada.js";

const balayage = GUIAS.find((g) => g.clave === "BALAYAGE")!;

describe("buscarGuia — la palabra clave en un comentario", () => {
  it.each([
    "BALAYAGE",
    "balayage",
    "Balayage 🙋‍♀️",
    "  balayage!!  ",
    "quiero la guia balayage",
    "Balayage por favor 🤎",
  ])("reconoce %j", (texto) => {
    expect(buscarGuia(texto)?.clave).toBe("BALAYAGE");
  });

  it("ignora tildes y mayúsculas al comparar", () => {
    // Una clave con tilde debe coincidir con el comentario sin ella y al revés.
    expect(buscarGuia("BALÁYAGE")?.clave).toBe("BALAYAGE");
  });

  it.each(["", "   ", "🔥🔥🔥", "me encantó", "balayages", "imbalayage", "microblading"])(
    "no la confunde en %j",
    (texto) => {
      expect(buscarGuia(texto)).toBeNull();
    },
  );

  it("no cuenta un comentario largo: eso es conversación, no un pedido", () => {
    const largo = "qué lindo quedó el balayage de mi hermana, ¿cuánto dura más o menos el color?";
    expect(largo.split(/\s+/).length).toBeGreaterThan(MAX_PALABRAS_COMENTARIO_CLAVE);
    expect(buscarGuia(largo)).toBeNull();
  });

  it("acepta justo el máximo de palabras y rechaza una más", () => {
    const enElLimite = ["balayage", ...Array(MAX_PALABRAS_COMENTARIO_CLAVE - 1).fill("hola")].join(" ");
    expect(buscarGuia(enElLimite)?.clave).toBe("BALAYAGE");
    expect(buscarGuia(`${enElLimite} hola`)).toBeNull();
  });
});

describe("mensajeGuia", () => {
  it("lleva el enlace exacto de la guía y su cierre", () => {
    const msg = mensajeGuia(balayage);
    expect(msg).toContain("https://aurastudio.pe/guias/balayage");
    expect(msg).toContain(balayage.cierre);
  });

  it("sin markdown (Instagram y Messenger no lo interpretan)", () => {
    expect(mensajeGuia(balayage)).not.toMatch(/[*_#`]/);
  });

  it("cabe con holgura en el límite de una respuesta privada (1000 bytes)", () => {
    expect(Buffer.byteLength(mensajeGuia(balayage), "utf8")).toBeLessThan(600);
  });
});

describe("elegirRespuestaPrivada", () => {
  const encendido: ConfigRespuestaPrivada = {
    activo: true,
    ia_comentarios_activa: true,
    texto_respuesta_privada: "Gracias por comentar, te escribimos por privado.",
  };

  it("con la palabra clave manda la guía, no el texto fijo", () => {
    const r = elegirRespuestaPrivada({ texto: "BALAYAGE", config: encendido });
    expect(r?.guia).toBe("BALAYAGE");
    expect(r?.texto).toContain("https://aurastudio.pe/guias/balayage");
  });

  it("sin palabra clave sigue mandando el texto fijo de siempre", () => {
    expect(elegirRespuestaPrivada({ texto: "qué bonito 😍", config: encendido })).toEqual({
      texto: "Gracias por comentar, te escribimos por privado.",
    });
  });

  it("con palabra clave y sin texto fijo configurado, la guía sale igual", () => {
    const r = elegirRespuestaPrivada({ texto: "balayage", config: { ...encendido, texto_respuesta_privada: null } });
    expect(r?.guia).toBe("BALAYAGE");
  });

  it("sin palabra clave y sin texto fijo, no manda nada", () => {
    expect(
      elegirRespuestaPrivada({ texto: "hola", config: { ...encendido, texto_respuesta_privada: null } }),
    ).toBeNull();
  });

  it("el interruptor del canal manda sobre todo: apagado no sale ni la guía", () => {
    expect(elegirRespuestaPrivada({ texto: "balayage", config: { ...encendido, activo: false } })).toBeNull();
    expect(
      elegirRespuestaPrivada({ texto: "balayage", config: { ...encendido, ia_comentarios_activa: false } }),
    ).toBeNull();
    expect(elegirRespuestaPrivada({ texto: "balayage", config: null })).toBeNull();
  });

  it("una respuesta anidada a otro comentario no gasta la respuesta privada", () => {
    expect(elegirRespuestaPrivada({ texto: "balayage", parentId: "123_456", config: encendido })).toBeNull();
  });

  it("parentId null o vacío cuenta como comentario original", () => {
    expect(elegirRespuestaPrivada({ texto: "balayage", parentId: null, config: encendido })?.guia).toBe("BALAYAGE");
    expect(elegirRespuestaPrivada({ texto: "balayage", parentId: "", config: encendido })?.guia).toBe("BALAYAGE");
  });
});
