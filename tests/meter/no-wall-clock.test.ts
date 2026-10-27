// Meter tests use no wall clock: every upstream wait goes through the
// loopback holds, the injected manual timers, or the fixture event waiter.
// setImmediate yields are transport propagation, not time, so they stay
// allowed; the ban covers setTimeout, Bun.sleep and the loopback delays.
import { expect, test } from "bun:test";

const BANNED = ["setTimeout(", "Bun.sleep(", "delayMs", "chunkDelayMs"];

test("meter tests use no wall clock", async () => {
  const { Glob } = await import("bun");
  const glob = new Glob("tests/meter/*.ts");
  const offenders: string[] = [];
  for await (const path of glob.scan({ cwd: "." })) {
    if (path.endsWith("no-wall-clock.test.ts") || path.endsWith("manual-timers.ts")) {
      continue;
    }
    const source = await Bun.file(path).text();
    for (const needle of BANNED) {
      if (source.includes(needle)) {
        offenders.push(`${path}: ${needle}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
