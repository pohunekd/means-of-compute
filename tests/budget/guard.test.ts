// Bounded unmeasured-audit spend (#136 slice A, row A1): an audit token
// entry that may be billed but reported no usage counts at the configured
// per-call bound instead of refusing as unknown; a null-token session
// entry on a priced provider still refuses.
import { expect, test } from "bun:test";
import { isBoundedAuditToken, summarizeSpend } from "../../src/budget/cost.js";
import type { NanoPricing } from "../../src/budget/pricing.js";
import type { SpendEntry } from "../../src/ledger/types.js";
import { AUDITOR_USAGE_SOURCE } from "../../src/ledger/types.js";

const BOUND = {
  auditCall: { inputTokens: 262144, outputTokens: 65536 },
  meterCall: { inputTokens: 16777216, outputTokens: 65536 },
};
const NOW = new Date("2026-10-28T12:00:00.000Z");

function pricing(): ReadonlyMap<string, NanoPricing> {
  return new Map([["meta-api", { inputNanoPer1M: 100_000_000n, outputNanoPer1M: 200_000_000n }]]);
}

function entry(workItemId: string, token: SpendEntry["tokens"][number]): SpendEntry {
  return {
    workItemId,
    finishedAt: "2026-10-28T10:00:00.000Z",
    tokens: [token],
  };
}

const AUDIT_TOKEN: SpendEntry["tokens"][number] = {
  provider: "meta-api",
  model: "muse-spark-1.3-contributor",
  inputTokens: null,
  outputTokens: null,
  requests: 1,
  source: AUDITOR_USAGE_SOURCE,
};

const SESSION_TOKEN: SpendEntry["tokens"][number] = {
  provider: "meta-api",
  model: "muse-spark-1.3-contributor",
  inputTokens: null,
  outputTokens: null,
  requests: 1,
  source: "meter-proxy",
};

const SESSION_TOKEN_4: SpendEntry["tokens"][number] = {
  ...SESSION_TOKEN,
  requests: 4,
};

test("metered entry with unmeasuredRequests counts each call at the meter bound", () => {
  const meterToken: SpendEntry["tokens"][number] = {
    provider: "meta-api",
    model: "muse-spark-1.3-contributor",
    inputTokens: 1000,
    outputTokens: 100,
    requests: 3,
    unmeasuredRequests: 1,
    source: "meter-proxy",
  };
  const summary = summarizeSpend(
    [entry("gh-demo-1", meterToken)],
    pricing(),
    "nvidia-build",
    NOW,
    BOUND,
  );
  expect(summary.unknownWorkItemIds).toEqual([]);
  expect(summary.boundedWorkItemIds).toEqual(["gh-demo-1"]);
  expect(summary.boundedTodayWorkItemIds).toEqual(["gh-demo-1"]);
  expect(summary.spentTotalNanoUsd).toBe(1690948800n);
  const earlier = summarizeSpend(
    [
      {
        workItemId: "gh-demo-9",
        finishedAt: "2026-10-26T10:00:00.000Z",
        tokens: [meterToken],
      },
    ],
    pricing(),
    "nvidia-build",
    NOW,
    BOUND,
  );
  expect(earlier.boundedWorkItemIds).toEqual(["gh-demo-9"]);
  expect(earlier.boundedTodayWorkItemIds).toEqual([]);
  const withNull = summarizeSpend(
    [
      entry("gh-demo-1", meterToken),
      entry("gh-demo-2", {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: null,
        outputTokens: null,
        requests: 1,
        source: "meter-proxy",
      }),
    ],
    pricing(),
    "nvidia-build",
    NOW,
    BOUND,
  );
  expect(withNull.unknownWorkItemIds).toEqual(["gh-demo-2"]);
});

test("A1 bounded audit spend counts at the bound, session stays unknown", () => {
  expect(isBoundedAuditToken(AUDIT_TOKEN)).toBe(true);
  expect(isBoundedAuditToken(SESSION_TOKEN)).toBe(false);
  const auditOnly = summarizeSpend(
    [entry("gh-demo-1", AUDIT_TOKEN)],
    pricing(),
    "nvidia-build",
    NOW,
    BOUND,
  );
  expect(auditOnly.unknownWorkItemIds).toEqual([]);
  expect(auditOnly.boundedWorkItemIds).toEqual(["gh-demo-1"]);
  expect(auditOnly.spentTotalNanoUsd).toBe(39321600n);
  const both = summarizeSpend(
    [entry("gh-demo-1", AUDIT_TOKEN), entry("gh-demo-2", SESSION_TOKEN)],
    pricing(),
    "nvidia-build",
    NOW,
    BOUND,
  );
  expect(both.unknownWorkItemIds).toEqual(["gh-demo-2"]);
  expect(both.boundedWorkItemIds).toEqual(["gh-demo-1"]);
  const mixed = summarizeSpend(
    [
      {
        workItemId: "gh-demo-3",
        finishedAt: "2026-10-28T10:00:00.000Z",
        tokens: [AUDIT_TOKEN, SESSION_TOKEN_4],
      },
    ],
    pricing(),
    "nvidia-build",
    NOW,
    BOUND,
  );
  expect(mixed.unknownWorkItemIds).toEqual(["gh-demo-3"]);
  expect(mixed.boundedWorkItemIds).toEqual([]);
});
