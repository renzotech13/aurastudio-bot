import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Valida `X-Hub-Signature-256` de Meta contra el body crudo del request, con
 * el mismo secreto que aplica al webhook en cuestión (WhatsApp y Meta pueden
 * compartir uno solo, ver config/env.ts). Compartida entre webhook.ts y
 * metaWebhook.ts para no tener dos implementaciones del mismo cálculo.
 */
export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!rawBody || !appSecret) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
