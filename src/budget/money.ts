// Exact money conversion for the budget guard. Decimal strings become
// integer nano-USD as BigInt: at most 9 decimals, no e/E notation. The same
// conversion parses validated descriptor prices, config caps and CLI flags,
// so no float ever reaches the decision path.
export const NANO_PER_USD = 1_000_000_000n;
const MAX_DECIMALS = 9;

export function decimalToNanoUsd(raw: string, what: string, file: string): bigint {
  if (raw.includes("e") || raw.includes("E")) {
    throw new Error(`Budget ${file}: invalid ${what} "${raw}"`);
  }
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(raw);
  if (match === null) {
    throw new Error(`Budget ${file}: invalid ${what} "${raw}"`);
  }
  const whole = BigInt(match[1] as string);
  const frac = (match[2] ?? "").padEnd(MAX_DECIMALS, "0");
  return whole * NANO_PER_USD + BigInt(frac);
}

/** A validated JSON price number to nano-USD, via its decimal text. */
export function priceToNanoUsd(value: number, what: string, file: string): bigint {
  return decimalToNanoUsd(value.toString(), what, file);
}
