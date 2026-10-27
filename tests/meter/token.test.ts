// Token tests: round trip through the design pattern, strict decode, and
// timing-safe comparison of the MAC.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { tokenFor, verifyBearer } from "../../src/meter/token.js";

// The base64url alphabet in order: the last character of a group may
// carry unused low bits, so two different spellings can decode to the
// same bytes. The strict decoder rejects every non-canonical spelling.
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function nextAlphabetChar(char: string): string {
  const at = BASE64URL_ALPHABET.indexOf(char);
  if (at < 0 || at + 1 >= BASE64URL_ALPHABET.length) {
    throw new Error(`test: no next alphabet char for ${char}`);
  }
  return BASE64URL_ALPHABET[at + 1] as string;
}

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

test("round trip returns the requestId", () => {
  const token = tokenFor(KEY_A, "demo-item:0");
  expect(verifyBearer(KEY_A, `Bearer ${token}`)).toBe("demo-item:0");
});

test("a different key rejects the token", () => {
  const token = tokenFor(KEY_A, "demo-item:0");
  expect(verifyBearer(KEY_B, `Bearer ${token}`)).toBeNull();
});

test("strict decode rejects malformed bearers", () => {
  const valid = tokenFor(KEY_A, "demo-item:0");
  const [, encoded, mac] = valid.split(".");
  const encodedPart = encoded as string;
  const macPart = mac as string;
  expect(verifyBearer(KEY_A, `Bearer moc1.*.${macPart}`)).toBeNull();
  expect(verifyBearer(KEY_A, `Bearer moc1.${encodedPart}.${macPart.slice(0, 42)}`)).toBeNull();
  expect(verifyBearer(KEY_A, `bearer ${valid}`)).toBeNull();
  expect(verifyBearer(KEY_A, `Bearer ${valid}.extra`)).toBeNull();
  expect(verifyBearer(KEY_A, null)).toBeNull();
});

test("a padded part 1 spelling is rejected", () => {
  // M02: a plain decoder accepts padding; the strict decoder must not.
  const requestId = "demo-item:0";
  const token = tokenFor(KEY_A, requestId);
  const [, encoded, mac] = token.split(".");
  expect(verifyBearer(KEY_A, `Bearer moc1.${String(encoded)}=.${String(mac)}`)).toBeNull();
});

test("a sibling part 1 spelling of the same bytes is rejected", () => {
  // M02: moving the last char of part 1 to the next alphabet char keeps
  // the decoded bytes (unused low bits) but changes the spelling.
  const requestId = "demo-item:0";
  const token = tokenFor(KEY_A, requestId);
  const [, encoded, mac] = token.split(".");
  const encodedPart = encoded as string;
  const sibling = encodedPart.slice(0, -1) + nextAlphabetChar(encodedPart.slice(-1));
  expect(Buffer.from(sibling, "base64url").toString()).toBe(requestId);
  expect(sibling).not.toBe(encodedPart);
  expect(verifyBearer(KEY_A, `Bearer moc1.${sibling}.${String(mac)}`)).toBeNull();
});

test("a sibling mac spelling of the same bytes is rejected", () => {
  // L3: the MAC gets a re-encode round trip, so a non-canonical spelling
  // of the same 32 bytes is rejected even though the bytes match.
  const requestId = "demo-item:0";
  const token = tokenFor(KEY_A, requestId);
  const [, encoded, mac] = token.split(".");
  const macPart = mac as string;
  const sibling = macPart.slice(0, -1) + nextAlphabetChar(macPart.slice(-1));
  expect(Buffer.from(sibling, "base64url").equals(Buffer.from(macPart, "base64url"))).toBe(true);
  expect(sibling).not.toBe(macPart);
  expect(verifyBearer(KEY_A, `Bearer moc1.${String(encoded)}.${sibling}`)).toBeNull();
});
