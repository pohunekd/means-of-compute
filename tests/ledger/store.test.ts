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
    await appendPending(
      ledgerPath,
      sessionEntry({
        entryId: "e2-session",
        finishedAt: "2026-10-26T11:40:00.000Z",
        startModel: "muse-spark-1.3-contributor",
        tokens: [
          {
            provider: "meta-api",
            model: "muse-spark-1.3-contributor",
            inputTokens: 100,
            outputTokens: 500,
            requests: 3,
            source: "provider-usage",
          },
        ],
        session: {
          hostAlias: "desktop",
          seconds: 60,
          source: "dispatcher-clock",
          result: "failure",
        },
      }),
    );
    expect(
      await finalizeUsage(ledgerPath, {
        workItemId: "w1-demo",
        result: "success",
        retries: 1,
        humanInterventions: 0,
      }),
    ).toBe("updated");
    const updated = await readLedger("Budget ledger", ledgerPath);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]?.tokens[0]?.inputTokens).toBeNull();
    expect(updated.records[0]?.tokens[0]?.requests).toBe(5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append with an invalid date throws LedgerDataError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-store-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    let error: unknown;
    try {
      await appendPending(
        ledgerPath,
        sessionEntry({ finishedAt: "2026-13-01T00:00:00.000Z" }),
      );
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LedgerDataError);
    expect((error as Error).message).toContain("finishedAt is not a valid date");
    expect(await Bun.file(ledgerPath).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append after finalize writes the record line before the pending line", async () => {
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
    await appendPending(
      ledgerPath,
      sessionEntry({ entryId: "e2-session", workItemId: "w2-other" }),
    );
    const lines = (await Bun.file(ledgerPath).text()).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).not.toHaveProperty("pending");
    expect(JSON.parse(lines[1] as string)).toHaveProperty("pending");
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

test("author models unions distinct models per source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-store-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    await appendPending(
      ledgerPath,
      sessionEntry({
        entryId: "e-session",
        workItemId: "w1-demo",
        startModel: "attempt-only-model",
        tokens: [
          {
            provider: "meta-api",
            model: "token-only-model",
            inputTokens: 10,
            outputTokens: 5,
            requests: 1,
            source: "provider-usage",
          },
        ],
      }),
    );
    await appendPending(
      ledgerPath,
      sessionEntry({
        entryId: "e-audit",
        kind: "audit",
        workItemId: "w1-demo",
        finishedAt: "2026-10-26T10:50:00.000Z",
        startModel: "other-session-model",
        tokens: [
          {
            provider: "meta-api",
            model: "audit-only-model",
            inputTokens: 10,
            outputTokens: 5,
            requests: 1,
            source: "auditor-usage",
          },
        ],
        session: null,
      }),
    );
    const record = {
      schemaVersion: "v1",
      workItemId: "w1-demo",
      finishedAt: "2026-10-26T11:00:00.000Z",
      tokens: [
        {
          provider: "meta-api",
          model: "record-token-only",
          inputTokens: 10,
          outputTokens: 5,
          requests: 1,
          source: "provider-usage",
        },
        {
          provider: "meta-api",
          model: "audit-only-record-model",
          inputTokens: 10,
          outputTokens: 5,
          requests: 1,
          source: "auditor-usage",
        },
      ],
      sessionSeconds: [{ hostAlias: "desktop", seconds: 60, source: "dispatcher-clock" }],
      attempts: [{ model: "record-attempt-only", result: "success" }],
      retries: 0,
      humanInterventions: 0,
      result: "success",
    };
    const session = sessionEntry({
      entryId: "e-session",
      workItemId: "w1-demo",
      startModel: "attempt-only-model",
      tokens: [
        {
          provider: "meta-api",
          model: "token-only-model",
          inputTokens: 10,
          outputTokens: 5,
          requests: 1,
          source: "provider-usage",
        },
      ],
    });
    const audit = sessionEntry({
      entryId: "e-audit",
      kind: "audit",
      workItemId: "w1-demo",
      finishedAt: "2026-10-26T10:50:00.000Z",
      startModel: "unrelated-start-model",
      tokens: [
        {
          provider: "meta-api",
          model: "audit-only-model",
          inputTokens: 10,
          outputTokens: 5,
          requests: 1,
          source: "auditor-usage",
        },
      ],
      session: null,
    });
    await Bun.write(
      ledgerPath,
      `${JSON.stringify(record)}\n${JSON.stringify({ pending: session })}\n${JSON.stringify({ pending: audit })}\n`,
    );
    const contents = await readLedger("Budget ledger", ledgerPath);
    expect(authorModelsOf(contents, "w1-demo")).toEqual([
      "attempt-only-model",
      "record-attempt-only",
      "record-token-only",
      "token-only-model",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
