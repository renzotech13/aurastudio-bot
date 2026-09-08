import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventosMeta, describeParsePayloadError } from "../src/meta/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures/meta");

function cargar(nombre: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, nombre), "utf8"));
}

describe("parseEventosMeta — Messenger", () => {
  it("texto de Messenger", () => {
    const [evento] = parseEventosMeta(cargar("messenger-texto.json"));
    expect(evento).toMatchObject({
      kind: "dm_texto",
      canal: "messenger",
      cuentaId: "PAGE_ID_TEST",
      externalId: "mid.messenger.texto.1",
      remitenteId: "PSID_ROSA",
      texto: "Hola, hacen microblading?",
    });
  });

  it("adjunto de Messenger", () => {
    const [evento] = parseEventosMeta(cargar("messenger-adjunto.json"));
    expect(evento).toMatchObject({
      kind: "dm_adjunto",
      remitenteId: "PSID_ROSA",
      attachmentType: "image",
      url: "https://cdn.meta.example/foto.jpg",
    });
  });

  it("eco (mensaje que salió de la página): remitenteId es la clienta, no la página", () => {
    const [evento] = parseEventosMeta(cargar("messenger-eco.json"));
    expect(evento).toMatchObject({
      kind: "dm_eco",
      remitenteId: "PSID_ROSA", // el recipient del payload, no el sender (que es la página)
      texto: "Claro, hacemos microblading desde S/ 250",
    });
  });

  it("postback", () => {
    const [evento] = parseEventosMeta(cargar("messenger-postback.json"));
    expect(evento).toMatchObject({ kind: "dm_postback", remitenteId: "PSID_ROSA", payload: "VER_SERVICIOS", titulo: "Ver servicios" });
  });
});

describe("parseEventosMeta — comentarios de Facebook", () => {
  it("comentario nuevo (add)", () => {
    const [evento] = parseEventosMeta(cargar("facebook-comentario-add.json"));
    expect(evento).toMatchObject({
      kind: "comentario_nuevo",
      canal: "messenger",
      externalId: "comment_fb_1",
      remitenteId: "USER_FB_1",
      nombrePerfil: "Carmen Diaz",
      texto: "Cuánto cuesta el corte de cabello?",
      hiloExterno: "PAGE_ID_TEST_post_1",
      parentId: null,
    });
  });

  it("comentario eliminado (remove)", () => {
    const [evento] = parseEventosMeta(cargar("facebook-comentario-remove.json"));
    expect(evento).toMatchObject({ kind: "comentario_eliminado", externalId: "comment_fb_1" });
  });

  it("comentario sin `from`: remitenteId null, no se descarta el evento completo", () => {
    const [evento] = parseEventosMeta(cargar("facebook-comentario-sin-from.json"));
    expect(evento).toMatchObject({ kind: "comentario_nuevo", remitenteId: null, externalId: "comment_fb_2" });
  });

  it("respuesta a otro comentario: parentId distinto de post_id", () => {
    const [evento] = parseEventosMeta(cargar("facebook-comentario-respuesta.json"));
    expect(evento).toMatchObject({ kind: "comentario_nuevo", parentId: "comment_fb_1", hiloExterno: "PAGE_ID_TEST_post_1" });
  });

  it("nuestro propio comentario (from.id === cuentaId) se descarta por completo", () => {
    const eventos = parseEventosMeta(cargar("facebook-comentario-propio.json"));
    expect(eventos).toHaveLength(0);
  });
});

describe("parseEventosMeta — Instagram", () => {
  it("DM de texto", () => {
    const [evento] = parseEventosMeta(cargar("instagram-dm-texto.json"));
    expect(evento).toMatchObject({ kind: "dm_texto", canal: "instagram", cuentaId: "IG_ID_TEST", remitenteId: "IGSID_ROSITA" });
  });

  it("respuesta a una historia: se reconoce como texto (reply_to.story se ignora, no rompe el parseo)", () => {
    const [evento] = parseEventosMeta(cargar("instagram-dm-story-reply.json"));
    expect(evento).toMatchObject({ kind: "dm_texto", texto: "Me interesa esto!" });
  });

  it("comentario de Instagram", () => {
    const [evento] = parseEventosMeta(cargar("instagram-comentario.json"));
    expect(evento).toMatchObject({
      kind: "comentario_nuevo",
      canal: "instagram",
      externalId: "comment_ig_1",
      remitenteId: "USER_IG_1",
      nombrePerfil: "rosita_ig",
      hiloExterno: "MEDIA_9",
    });
  });
});

describe("parseEventosMeta — payload que no calza", () => {
  it("describeParsePayloadError explica el motivo en vez de fallar en silencio", () => {
    const error = describeParsePayloadError({ object: "algo_raro" });
    expect(error).not.toBeNull();
  });

  it("parseEventosMeta devuelve [] para un payload que no calza", () => {
    expect(parseEventosMeta({ object: "algo_raro" })).toEqual([]);
  });

  it("un campo de webhook no manejado se reporta como no_soportado, no se descarta en silencio", () => {
    const payload = {
      object: "page",
      entry: [{ id: "PAGE_ID_TEST", changes: [{ field: "ratings", value: { rating: 5 } }] }],
    };
    const [evento] = parseEventosMeta(payload);
    expect(evento).toMatchObject({ kind: "no_soportado" });
  });
});
