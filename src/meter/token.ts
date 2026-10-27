// Session credential for the metering proxy. The token is derived and never
// stored: base64url(requestId) plus an HMAC bound to the factory secret.
import { createHmac, timingSafeEqual } from "node:crypto";

export const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}:(0|[1-9][0-9]*)$/;
const TOKEN_PREFIX = "moc1";
const PART1_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function macFor(secret: Buffer, requestId: string): Buffer {
  return createHmac("sha256", secret).update(`moc-meter-v1\n${requestId}`, "utf8").digest();
}

function strictBase64UrlDecode(part: string): Buffer | null {
  if (!PART1_PATTERN.test(part)) {
    return null;
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(part, "base64url");
  } catch {
    return null;
  }
  if (decoded.toString("base64url") !== part) {
    return null;
  }
  return decoded;
}

export function tokenFor(secret: Buffer, requestId: string): string {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(`meter: invalid requestId for token`);
  }
  const encoded = Buffer.from(requestId, "utf8").toString("base64url");
  const mac = macFor(secret, requestId).toString("base64url");
  return `${TOKEN_PREFIX}.${encoded}.${mac}`;
}

export function verifyBearer(secret: Buffer, header: string | null): string | null {
  if (header === null || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return null;
  }
  const encoded = parts[1] as string;
  const macText = parts[2] as string;
  if (!MAC_PATTERN.test(macText)) {
    return null;
  }
  const decoded = strictBase64UrlDecode(encoded);
  if (decoded === null) {
    return null;
  }
  const requestId = decoded.toString("utf8");
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return null;
  }
  let given: Buffer;
  try {
    given = Buffer.from(macText, "base64url");
  } catch {
    return null;
  }
  if (given.length !== 32) {
    return null;
  }
  const expected = macFor(secret, requestId);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  return requestId;
}
