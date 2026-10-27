// Ledger query tests: the output for the D2 fixture equals the
// hand-computed query-expected.json, and pending entries never leak into
// the breakdowns.
import { expect, test } from "bun:test";
import type { LedgerContents } from "../../src/ledger/types.js";
import type { LedgerQueryResult } from "../../src/ledger/query.js";
import { queryLedger } from "../../src/ledger/query.js";
import { readLedger } from "../../src/ledger/read.js";

const FIXTURE = "tests/fixtures/ledger/ledger.jsonl";
const EXPECTED = "tests/fixtures/ledger/query-expected.json";

test("query output equals the hand-computed expected file", async () => {
  const contents = await readLedger("Ledger query", FIXTURE);
  const result = queryLedger(contents, new Set(["provider", "host", "model"]));
  const expected = (await Bun.file(EXPECTED).json()) as unknown as LedgerQueryResult;
  expect(result).toEqual(expected);
});

test("query with one dimension returns only that breakdown", async () => {
  const contents = await readLedger("Ledger query", FIXTURE);
  const result = queryLedger(contents, new Set(["host"]));
  expect(result.records).toBe(3);
  expect(result.pendingEntries).toBe(1);
  expect(result.byHost).toHaveLength(2);
  expect(result.byProvider).toBeUndefined();
  expect(result.byModel).toBeUndefined();
});

test("query ignores pending entries in every breakdown", async () => {
  const contents = await readLedger("Ledger query", FIXTURE);
  const result = queryLedger(contents, new Set(["provider", "host", "model"]));
  const text = JSON.stringify(result);
  expect(contents.pending).toHaveLength(1);
  expect(result.pendingEntries).toBe(1);
  expect(text).not.toContain("w4-open");
  expect(text).not.toContain("e9-open");
});

test("query byProvider keeps null input tokens null", async () => {
  const contents: LedgerContents = {
    records: [
      {
        schemaVersion: "v1",
        workItemId: "w1-demo",
        finishedAt: "2026-10-26T10:45:00.000Z",
        tokens: [
          {
            provider: "meta-api",
            model: "m",
            inputTokens: null,
            outputTokens: 10,
            requests: 1,
            source: "provider-usage",
          },
          {
            provider: "meta-api",
            model: "m",
            inputTokens: 100,
            outputTokens: 10,
            requests: 1,
            source: "provider-usage",
          },
        ],
        sessionSeconds: [{ hostAlias: "desktop", seconds: 60, source: "dispatcher-clock" }],
        attempts: [{ model: "m", result: "success" }],
        retries: 0,
        humanInterventions: 0,
        result: "success",
      },
    ],
    pending: [],
  };
  const result = queryLedger(contents, new Set(["provider"]));
  expect(result.byProvider).toHaveLength(1);
  expect(result.byProvider?.[0]?.inputTokens).toBeNull();
  expect(result.byProvider?.[0]?.requests).toBe(2);
});

test("query byModel is attempt-level, not record-level", async () => {
  const contents: LedgerContents = {
    records: [
      {
        schemaVersion: "v1",
        workItemId: "w1-demo",
        finishedAt: "2026-10-26T10:45:00.000Z",
        tokens: [
          {
            provider: "meta-api",
            model: "m",
            inputTokens: 10,
            outputTokens: 10,
            requests: 1,
            source: "provider-usage",
          },
        ],
        sessionSeconds: [{ hostAlias: "desktop", seconds: 60, source: "dispatcher-clock" }],
        attempts: [
          { model: "m", result: "failure" },
          { model: "m", result: "failure" },
          { model: "m", result: "success" },
        ],
        retries: 2,
        humanInterventions: 0,
        result: "success",
      },
    ],
    pending: [],
  };
  const result = queryLedger(contents, new Set(["model"]));
  expect(result.byModel).toEqual([
    { model: "m", attempts: 3, successes: 1, successRate: "0.3333" },
  ]);
});
