// Budget money tests: decimal text becomes exact nano-USD, text with an
// exponent, a sign or more than 9 decimals is refused with its label, and a
// JSON price converts through its decimal text. Deterministic: no clock, no I/O.
import { expect, test } from "bun:test";
import { decimalToNanoUsd, priceToNanoUsd } from "../../src/budget/money.js";

const FILE = "config/budget.json";

test("decimal text becomes exact nano-USD", () => {
  expect(decimalToNanoUsd("0", "cap", FILE)).toBe(0n);
  expect(decimalToNanoUsd("1.5", "cap", FILE)).toBe(1_500_000_000n);
  expect(decimalToNanoUsd("0.000000001", "cap", FILE)).toBe(1n);
  expect(decimalToNanoUsd("12.345678912", "cap", FILE)).toBe(12_345_678_912n);
});

test("an exponent, a sign, a bare point or a tenth decimal is refused", () => {
  for (const raw of ["1e3", "1E3", "-1", ".5", "1.", "1.0000000001"]) {
    expect(() => decimalToNanoUsd(raw, "cap", FILE)).toThrow(
      `Budget config/budget.json: invalid cap "${raw}"`,
    );
  }
});

test("a JSON price converts through its decimal text", () => {
  expect(priceToNanoUsd(2.5, "price", FILE)).toBe(2_500_000_000n);
  expect(priceToNanoUsd(0.000002, "price", FILE)).toBe(2_000n);
  expect(() => priceToNanoUsd(1e-7, "price", FILE)).toThrow(
    'Budget config/budget.json: invalid price "1e-7"',
  );
});
