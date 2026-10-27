// Token tests: round trip through the design pattern, strict decode, and
// timing-safe comparison of the MAC.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { tokenFor, verifyBearer } from "../../src/meter/token.js";

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
