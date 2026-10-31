// Row 1: three rejections on one host within the window cool it for every item.
import { expect, test } from "bun:test";
import { cooledHosts } from "../../src/loop/host-cooldown.js";
import type { LoopHostCooldownConfig } from "../../src/loop/config.js";
import type { RoundOutcome, RoundRecord } from "../../src/loop/types.js";

function round(
  hostAlias: string,
  at: string,
  outcome: RoundOutcome = "start-rejected",
): RoundRecord {
  return {
    round: 0,
    retry: 0,
    requestId: null,
    model: "m",
    providerId: "p",
    hostAlias,
    attempt: "failure",
    outcome,
    headSha: null,
    failingChecks: [],
    verdict: null,
    newlyMet: [],
    at,
    baseRace: false,
  };
}

test("three rejections on one host within the window cool it for every item until cooldownMs after the third", () => {
  const config: LoopHostCooldownConfig = { rejections: 3, windowMs: 600_000, cooldownMs: 900_000 };
  const t0 = Date.parse("2026-10-31T19:47:00.000Z");
  const items = [
    {
      rounds: [
        round("host-a", new Date(t0).toISOString()),
        round("host-a", new Date(t0 + 60_000).toISOString()),
      ],
    },
    {
      rounds: [
        round("host-a", new Date(t0 + 120_000).toISOString()),
        round("host-b", new Date(t0).toISOString()),
        round("host-b", new Date(t0 + 700_000).toISOString()),
        round("host-b", new Date(t0 + 710_000).toISOString(), "lost"),
      ],
    },
    { rounds: [round("host-b", new Date(t0 + 1_400_000).toISOString())] },
  ];
  expect(cooledHosts(items, config, t0 + 130_000)).toEqual(
    new Map([["host-a", t0 + 120_000 + 900_000]]),
  );
  expect(cooledHosts(items, config, t0 + 120_000 + 900_000).size).toBe(0);
});
