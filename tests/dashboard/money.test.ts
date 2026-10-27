// Dashboard money tests. Expected values come from the design section 6
// arithmetic and section 10.2, never from the code under test.
import { describe, expect, test } from "bun:test";
import {
  formatUsd,
  groupDigits,
  hourCostScaled,
  priceText,
  tokenCostScaled,
} from "../../src/dashboard/money.js";

describe("dashboard money rounding", () => {
  test("half case rounds half away from zero (mutation: truncate instead of half away)", () => {
    expect(formatUsd(hourCostScaled(1, 180_000_000n))).toBe("$0.0001");
    expect(formatUsd(-hourCostScaled(1, 180_000_000n))).toBe("-$0.0001");
  });

  test("tiny value rounds to zero without a sign", () => {
    expect(formatUsd(hourCostScaled(1, 1n))).toBe("$0.0000");
    expect(formatUsd(-hourCostScaled(1, 1n))).toBe("$0.0000");
  });

  test("token and hour sums add without float division", () => {
    const one = tokenCostScaled(1_000_000, 100_000_000n);
    expect(formatUsd(one)).toBe("$0.1000");
    const both = one + tokenCostScaled(500_000, 200_000_000n);
    expect(formatUsd(both)).toBe("$0.2000");
  });
});

describe("dashboard price text", () => {
  test("priceText examples of 6.2 (mutation: float division)", () => {
    expect(priceText(100_000_000n)).toBe("0.1");
    expect(priceText(0n)).toBe("0");
    expect(priceText(3_000_000_000n)).toBe("3");
    expect(priceText(2_000_000n)).toBe("0.002");
  });
});

describe("dashboard digit grouping", () => {
  test("groupDigits(1200000) is 1,200,000 (mutation: toLocaleString)", () => {
    expect(groupDigits(1_200_000)).toBe("1,200,000");
    expect(groupDigits(0)).toBe("0");
    expect(groupDigits(1000)).toBe("1,000");
    expect(groupDigits(31)).toBe("31");
  });
});
