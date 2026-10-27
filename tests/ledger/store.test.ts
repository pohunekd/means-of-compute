// Ledger store tests: null propagation, no fabricated record, usage
// unknown, and author models over stored content.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingUsage } from "../../src/ledger/types.js";
import {
  LedgerDataError,
  LedgerRefusal,
  appendPending,
  finalizeUsage,
} from "../../src/ledger/store.js";
import { authorModelsOf, readLedger } from "../../src/ledger/read.js";

function sessionEntry(overrides: Partial<PendingUsage> = {}): PendingUsage {
  return {
    entryId: "e1-session",
    kind: "session",
    workItemId: "w1-demo",
    finishedAt: "2026-10-26T10:40:00.000Z",
    startModel: "meta/muse-glimmer-30b",
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: null,
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

test("null input tokens propagate as null through finalize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-store-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    await appendPending(ledgerPath, sessionEntry());
    expect(
      await finalizeUsage(ledgerPath, {
        workItemId: "w1-demo",
        result: "success",
        retries: 0,
        humanInterventions: 0,
      }),
    ).toBe("appended");
    const contents = await readLedger("Budget ledger", ledgerPath);
    expect(contents.records).toHaveLength(1);
    expect(contents.records[0]?.tokens[0]?.inputTokens).toBeNull();
    expect(contents.records[0]?.tokens[0]?.requests).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize with no pending and no record refuses and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-store-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    let error: unknown;
    try {
      await finalizeUsage(ledgerPath, {
        workItemId: "w9-missing",
        result: "success",
        retries: 0,
        humanInterventions: 0,
      });
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LedgerRefusal);
    expect((error as LedgerRefusal).reason).toContain("no usage recorded for w9-missing");
    expect(await Bun.file(ledgerPath).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize with null requests refuses and keeps the entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-store-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    await appendPending(
      ledgerPath,
      sessionEntry({
        tokens: [
          {
            provider: "nvidia-build",
            model: "meta/muse-glimmer-30b",
            inputTokens: 10,
            outputTokens: 10,
            requests: null,
            source: "dispatcher-usage",
          },
        ],
      }),
    );
    let error: unknown;
    try {
      await finalizeUsage(ledgerPath, {
        workItemId: "w1-demo",
        result: "success",
        retries: 0,
        humanInterventions: 0,
      });
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LedgerRefusal);
    expect((error as LedgerRefusal).reason).toContain("usage unknown for w1-demo: e1-session");
    const contents = await readLedger("Budget ledger", ledgerPath);
    expect(contents.records).toHaveLength(0);
    expect(contents.pending).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize with a bogus result throws and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-store-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    await appendPending(ledgerPath, sessionEntry());
    await finalizeUsage(ledgerPath, {
      workItemId: "w1-demo",
      result: "success",
      retries: 0,
      humanInterventions: 0,
    });
    const before = await Bun.file(ledgerPath).text();
    let error: unknown;
    try {
      await finalizeUsage(ledgerPath, {
        workItemId: "w1-demo",
        result: "bogus",
        retries: 0,
        humanInterventions: 0,
      } as never);
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LedgerDataError);
    expect((error as Error).message).toContain("invalid result");
    expect(await Bun.file(ledgerPath).text()).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize with decreasing counters exits 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-store-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    await appendPending(
      ledgerPath,
      sessionEntry({
        tokens: [
          {
            provider: "meta-api",
            model: "m",
            inputTokens: 1,
            outputTokens: 1,
            requests: 1,
            source: "provider-usage",
          },
        ],
      }),
    );
    await finalizeUsage(ledgerPath, {
      workItemId: "w1-demo",
      result: "blocked",
      retries: 2,
      humanInterventions: 0,
    });
    let error: unknown;
    try {
      await finalizeUsage(ledgerPath, {
        workItemId: "w1-demo",
        result: "success",
        retries: 1,
        humanInterventions: 0,
      });
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LedgerDataError);
    expect((error as Error).message).toContain("counters must not decrease");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("author models from stored pending and record content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-store-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    await appendPending(ledgerPath, sessionEntry({ workItemId: "w2-other" }));
    await appendPending(
      ledgerPath,
      sessionEntry({
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
      }),
    );
    const contents = await readLedger("Budget ledger", ledgerPath);
    expect(authorModelsOf(contents, "w1-demo")).toEqual([]);
    expect(authorModelsOf(contents, "w2-other")).toEqual([
      "meta/muse-glimmer-30b",
      "muse-spark-1.3-contributor",
    ]);
    await appendPending(
      ledgerPath,
      sessionEntry({
        entryId: "e3-session",
        workItemId: "w1-demo",
        finishedAt: "2026-10-26T10:55:00.000Z",
      }),
    );
    const withSession = await readLedger("Budget ledger", ledgerPath);
    expect(authorModelsOf(withSession, "w1-demo")).toEqual([
      "meta/muse-glimmer-30b",
      "muse-spark-1.3-contributor",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
