// Ledger reader tests: record and pending line parsing, duplicate id
// errors, unterminated last line, ledger config loading, and the author
// models helper used by the auditor choice.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageRecord } from "../../contracts/v1/types.js";
import type { PendingUsage } from "../../src/ledger/types.js";
import { authorModelsOf, loadLedgerConfig, readLedger } from "../../src/ledger/read.js";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schemaVersion: "v1",
    workItemId: "w1-demo",
    finishedAt: "2026-10-26T10:45:00.000Z",
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 1000,
        outputTokens: 500,
        requests: 2,
        source: "provider-usage",
      },
    ],
    sessionSeconds: [{ hostAlias: "desktop", seconds: 540, source: "dispatcher-clock" }],
    attempts: [{ model: "muse-spark-1.3-contributor", result: "success" }],
    retries: 0,
    humanInterventions: 0,
    result: "success",
    ...overrides,
  };
}

function pending(overrides: Partial<PendingUsage> = {}): PendingUsage {
  return {
    entryId: "e1-demo",
    kind: "session",
    workItemId: "w1-demo",
    finishedAt: "2026-10-26T10:40:00.000Z",
    startModel: "meta/muse-glimmer-30b",
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 1000,
        outputTokens: 500,
        requests: 2,
        source: "provider-usage",
      },
    ],
    session: {
      hostAlias: "desktop",
      seconds: 540,
      source: "dispatcher-clock",
      result: "success",
    },
    ...overrides,
  };
}

test("reader returns records and pending entries in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-read-"));
  try {
    const path = join(dir, "ledger.jsonl");
    await Bun.write(
      path,
      `${JSON.stringify(record())}\n${JSON.stringify({ pending: pending() })}\n`,
    );
    const contents = await readLedger("Budget ledger", path);
    expect(contents.records).toHaveLength(1);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.entryId).toBe("e1-demo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader duplicate record id exits 2 naming both lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-read-"));
  try {
    const path = join(dir, "ledger.jsonl");
    const both = [record(), record({ finishedAt: "2026-10-26T11:00:00.000Z" })]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await Bun.write(path, `${both}\n`);
    let message = "";
    try {
      await readLedger("Budget ledger", path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("duplicate record workItemId w1-demo");
    expect(message).toContain("lines 1 and 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader duplicate pending id exits 2 naming both lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-read-"));
  try {
    const path = join(dir, "ledger.jsonl");
    const both = [pending(), pending({ finishedAt: "2026-10-26T11:00:00.000Z" })]
      .map((entry) => JSON.stringify({ pending: entry }))
      .join("\n");
    await Bun.write(path, `${both}\n`);
    let message = "";
    try {
      await readLedger("Budget ledger", path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("duplicate pending entryId e1-demo");
    expect(message).toContain("lines 1 and 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader unterminated last line exits 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-read-"));
  try {
    const path = join(dir, "ledger.jsonl");
    await Bun.write(path, `${JSON.stringify(record())}`);
    let message = "";
    try {
      await readLedger("Budget ledger", path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("last line is not terminated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader invalid pending line exits 2 with the line number", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-read-"));
  try {
    const path = join(dir, "ledger.jsonl");
    const bad = { ...pending(), session: null };
    await Bun.write(path, `${JSON.stringify({ pending: bad })}\n`);
    let message = "";
    try {
      await readLedger("Budget ledger", path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("line 1");
    expect(message).toContain("invalid pending entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLedgerConfig reads the ledger path and rejects extras", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-config-"));
  try {
    const path = join(dir, "ledger.json");
    await Bun.write(path, JSON.stringify({ ledgerPath: "logs/usage-ledger.jsonl" }));
    expect(await loadLedgerConfig(path)).toEqual({ ledgerPath: "logs/usage-ledger.jsonl" });
    await Bun.write(
      path,
      JSON.stringify({ ledgerPath: "logs/usage-ledger.jsonl", lockPath: "x.lock" }),
    );
    let message = "";
    try {
      await loadLedgerConfig(path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('"ledgerPath"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("author models unions session models and record attempts", async () => {
  const sessionEntry = pending({
    startModel: "meta/muse-glimmer-30b",
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 100,
        outputTokens: 50,
        requests: 1,
        source: "provider-usage",
      },
    ],
  });
  const auditEntry: PendingUsage = {
    entryId: "e2-audit",
    kind: "audit",
    workItemId: "w1-demo",
    finishedAt: "2026-10-26T10:50:00.000Z",
    startModel: "muse-spark-1.3-contributor",
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 10,
        outputTokens: 5,
        requests: 1,
        source: "auditor-usage",
      },
    ],
    session: null,
  };
  const finished = record({
    attempts: [
      { model: "meta/muse-glimmer-30b", result: "failure" },
      { model: "muse-spark-1.3-contributor", result: "success" },
    ],
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 100,
        outputTokens: 50,
        requests: 1,
        source: "provider-usage",
      },
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 10,
        outputTokens: 5,
        requests: 1,
        source: "auditor-usage",
      },
    ],
  });
  expect(
    authorModelsOf({ records: [finished], pending: [sessionEntry, auditEntry] }, "w1-demo"),
  ).toEqual(["meta/muse-glimmer-30b", "muse-spark-1.3-contributor"]);
});
