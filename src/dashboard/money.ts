// Exact dashboard money arithmetic. Every value is a bigint in scaled
// units (MONEY_SCALE per nano-USD), so token costs (per 1M) and hour costs
// (per 3600 s) add without rounding. Display is the only rounding: formatUsd
// rounds once, half away from zero, to 4 decimals.
export const MONEY_SCALE = 3_600_000_000n;

const USD_UNIT = 100_000n * MONEY_SCALE;

// Token cost of one token row: tokens * nanoPer1M * 3600, in scaled units.
export function tokenCostScaled(tokens: number, nanoPer1M: bigint): bigint {
  return BigInt(tokens) * nanoPer1M * 3600n;
}

// Compute cost of one session row: seconds * nanoPerHour * 1_000_000.
export function hourCostScaled(seconds: number, nanoPerHour: bigint): bigint {
  return BigInt(seconds) * nanoPerHour * 1_000_000n;
}

// SpendSummary fields come undivided (tokens * priceNanoPer1M); scaling
// them to display units multiplies by 3600.
export function guardScaled(nanoTimes1M: bigint): bigint {
  return nanoTimes1M * 3600n;
}

// Nano-USD caps scale by MONEY_SCALE into display units.
export function capScaled(nano: bigint): bigint {
  return nano * MONEY_SCALE;
}

// Exact decimal price of nano nano-USD: whole dollars plus the fraction
// padded to 9 digits with trailing zeros removed.
export function priceText(nano: bigint): string {
  const whole = nano / 1_000_000_000n;
  const frac = nano % 1_000_000_000n;
  if (frac === 0n) {
    return whole.toString();
  }
  const digits = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole.toString()}.${digits}`;
}

// Group the digits of a non-negative integer with "," every 3 from the right.
export function groupDigits(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("dashboard money: groupDigits needs a non-negative integer");
  }
  const text = String(n);
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 3) {
    parts.unshift(rest.slice(-3));
    rest = rest.slice(0, -3);
  }
  parts.unshift(rest);
  return parts.join(",");
}

// Format scaled units as USD with 4 decimals, rounding half away from zero.
// A zero value never carries a sign.
export function formatUsd(scaled: bigint): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const q = (2n * magnitude + USD_UNIT) / (2n * USD_UNIT);
  if (q === 0n) {
    return "$0.0000";
  }
  const sign = negative ? "-" : "";
  return `${sign}$${(q / 10000n).toString()}.${(q % 10000n).toString().padStart(4, "0")}`;
}
