// Idempotency tests (DoD D3): a second completion updates counters instead
// of adding a row, a finalize replay is unchanged with identical bytes, and
// a pending replay is unchanged unless the content differs.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerDataError } from "../../src/ledger/store.js";
import { appendPending, finalizeUsage } from "../../src/ledger/store.js";
import type { PendingUsage } from "../../src/ledger/types.js";

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

test("blocked then done gives one record line with summed tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-idem-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    expect(await appendPending(ledgerPath, sessionEntry())).toBe("appended");
    expect(
      await finalizeUsage(ledgerPath, {
        workItemId: "w1-demo",
        result: "blocked",
        retries: 1,
        humanInterventions: 0,
      }),
    ).toBe("appended");
    expect(
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
              inputTokens: 2000,
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
      ),
    ).toBe("appended");
    expect(
      await finalizeUsage(ledgerPath, {
        workItemId: "w1-demo",
        result: "success",
        retries: 2,
        humanInterventions: 1,
      }),
    ).toBe("updated");
    const text = await Bun.file(ledgerPath).text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as {
      result: string;
      retries: number;
      humanInterventions: number;
      finishedAt: string;
      tokens: { inputTokens: number; outputTokens: number; requests: number }[];
      sessionSeconds: { seconds: number }[];
      attempts: { model: string; result: string }[];
    };
    expect(record.result).toBe("success");
    expect(record.retries).toBe(2);
    expect(record.humanInterventions).toBe(1);
    expect(record.finishedAt).toBe("2026-10-26T11:40:00.000Z");
    expect(record.tokens).toHaveLength(1);
    expect(record.tokens[0]).toMatchObject({ inputTokens: 3000, outputTokens: 1000, requests: 5 });
    expect(record.sessionSeconds).toHaveLength(1);
    expect(record.sessionSeconds[0]).toMatchObject({ seconds: 600 });
    expect(record.attempts).toEqual([
      { model: "meta/muse-glimmer-30b", result: "success" },
      { model: "muse-spark-1.3-contributor", result: "failure" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize replay returns unchanged with identical bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-idem-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    await appendPending(ledgerPath, sessionEntry());
    const input = {
      workItemId: "w1-demo",
      result: "success" as const,
      retries: 0,
      humanInterventions: 0,
    };
    expect(await finalizeUsage(ledgerPath, input)).toBe("appended");
    const before = await Bun.file(ledgerPath).text();
    await appendPending(ledgerPath, sessionEntry({ entryId: "e2-other", workItemId: "w2-other" }));
    const withOther = await Bun.file(ledgerPath).text();
    expect(await finalizeUsage(ledgerPath, input)).toBe("unchanged");
    expect(await Bun.file(ledgerPath).text()).toBe(withOther);
    expect(await Bun.file(ledgerPath).text()).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending replay returns unchanged; changed content exits 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-idem-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    expect(await appendPending(ledgerPath, sessionEntry())).toBe("appended");
    expect(await appendPending(ledgerPath, sessionEntry())).toBe("unchanged");
    let message = "";
    try {
      await appendPending(ledgerPath, sessionEntry({ finishedAt: "2026-10-26T12:00:00.000Z" }));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
      expect(error).toBeInstanceOf(LedgerDataError);
    }
    expect(message).toContain("exists with different content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
