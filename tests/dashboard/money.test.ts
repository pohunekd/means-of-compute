// Dashboard money tests: token and hour costs add exactly in one scaled
// unit, formatUsd rounds once half away from zero with no signed zero, and
// priceText and groupDigits print exact text. Deterministic: no clock, no I/O.
import { expect, test } from "bun:test";
import {
  capScaled,
  formatUsd,
  groupDigits,
  hourCostScaled,
  priceText,
  tokenCostScaled,
} from "../../src/dashboard/money.js";

test("a token cost and an hour cost add exactly in scaled units", () => {
  const tokens = tokenCostScaled(1_000_000, 2_500_000_000n);
  const hours = hourCostScaled(1800, 1_000_000_000n);
  expect(tokens + hours).toBe(capScaled(3_000_000_000n));
  expect(formatUsd(tokens + hours)).toBe("$3.0000");
});

test("formatUsd rounds half away from zero and never signs zero", () => {
  expect(formatUsd(capScaled(50_000n))).toBe("$0.0001");
  expect(formatUsd(capScaled(49_999n))).toBe("$0.0000");
  expect(formatUsd(-capScaled(50_000n))).toBe("-$0.0001");
  expect(formatUsd(-capScaled(49_999n))).toBe("$0.0000");
});

test("priceText and groupDigits print exact text", () => {
  expect(priceText(2_500_000_000n)).toBe("2.5");
  expect(priceText(3_000_000_000n)).toBe("3");
  expect(priceText(1n)).toBe("0.000000001");
  expect(groupDigits(1_234_567)).toBe("1,234,567");
  expect(groupDigits(999)).toBe("999");
  expect(() => groupDigits(-1)).toThrow("groupDigits needs a non-negative integer");
});
