/**
 * Envía un fixture de tests/fixtures/meta/*.json al webhook de Meta local,
 * firmado exactamente como lo firmaría Meta — para probar todo el pipeline
 * (parser → identidades → conversación → agente → envío) sin credenciales
 * reales ni depender de que la app ya esté aprobada.
 *
 * Uso:
 *   npm run simular:meta -- messenger-texto
 *   npm run simular:meta -- instagram-comentario
 *   npm run simular:meta -- messenger-texto --url https://bot.aurastudio.pe/webhook/meta
 *
 * Requiere META_APP_SECRET (o WHATSAPP_APP_SECRET si Messenger/Instagram
 * viven en la misma app) en el entorno — el mismo valor que ya tiene el
 * servidor al que le vas a mandar el fixture, si no la firma no calza.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "tests", "fixtures", "meta");

function listarFixtures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function firmar(body: string, secreto: string): string {
  return "sha256=" + createHmac("sha256", secreto).update(body).digest("hex");
}

async function main() {
  const args = process.argv.slice(2);
  const nombre = args[0];
  const urlIdx = args.indexOf("--url");
  const url = urlIdx !== -1 ? args[urlIdx + 1] : "http://localhost:3000/webhook/meta";

  const disponibles = listarFixtures();

  if (!nombre || nombre.startsWith("--")) {
    console.error("Uso: npm run simular:meta -- <fixture> [--url <url>]\n");
    console.error("Fixtures disponibles:");
    for (const f of disponibles) console.error(`  - ${f}`);
    process.exit(1);
  }

  if (!disponibles.includes(nombre)) {
    console.error(`No existe el fixture "${nombre}". Disponibles:\n${disponibles.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }

  const secreto = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET;
  if (!secreto) {
    console.error("Falta META_APP_SECRET (o WHATSAPP_APP_SECRET) en el entorno — es lo que firma el fixture.");
    process.exit(1);
  }

  const body = readFileSync(join(FIXTURES_DIR, `${nombre}.json`), "utf8");
  const firma = firmar(body, secreto);

  console.log(`→ POST ${url}  (fixture: ${nombre})`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": firma },
    body,
  });

  console.log(`← ${res.status} ${res.statusText}`);
  const texto = await res.text();
  if (texto) console.log(texto);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
