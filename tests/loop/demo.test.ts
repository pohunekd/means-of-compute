// Demo run (#17 D1, design section 7, amendment 1 A5): the stub run over
// the three-item fixture queue merges all three without prompts, twice in
// a row against the same sandbox, with metered session usage in the demo
// ledger and nothing written outside the sandbox but the registry.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const DONE = "loop: stub run done merged=3 blocked=0 parked=0";

async function runDemo(): Promise<{ readonly rc: number; readonly stdout: string }> {
  const proc = Bun.spawn(
    ["bun", "run", "src/loop/main.ts", "--stub", "--queue", "tests/fixtures/loop/queue.json"],
    {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, rc] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { rc, stdout };
}

function ledgerRecords(): { workItemId: string; result: string; tokens: unknown[] }[] {
  return readFileSync("logs/loop-demo/ledger.jsonl", "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => !("pending" in entry)) as {
    workItemId: string;
    result: string;
    tokens: unknown[];
  }[];
}

test(
  "the stub demo merges the three queue items, twice in a row (D1)",
  async () => {
    const meterLogBefore = existsSync("logs/meter-usage.jsonl")
      ? readFileSync("logs/meter-usage.jsonl", "utf8")
      : null;
    for (let run = 0; run < 2; run += 1) {
      const { rc, stdout } = await runDemo();
      expect(rc).toBe(0);
      expect(stdout.trimEnd().split("\n").at(-1)).toBe(DONE);
      const merged = readFileSync("logs/loop-demo/loop.jsonl", "utf8")
        .split("\n")
        .filter((line) => line.includes('"event":"merged"'));
      expect(merged).toHaveLength(3);
      const records = ledgerRecords();
      expect(records.map((record) => [record.workItemId, record.result])).toEqual([
        ["demo-a", "success"],
        ["demo-b", "success"],
        ["demo-c", "success"],
      ]);
      for (const record of records) {
        expect(record.tokens).toEqual([
          {
            provider: "nvidia-build",
            model: "meta/muse-glimmer-30b",
            inputTokens: 1200,
            outputTokens: 80,
            requests: 1,
            source: "meter-proxy",
          },
          {
            provider: "meta-api",
            model: "muse-spark-1.3-contributor",
            inputTokens: 300,
            outputTokens: 8,
            requests: 1,
            source: "auditor-usage",
          },
        ]);
      }
    }
    const meterLogAfter = existsSync("logs/meter-usage.jsonl")
      ? readFileSync("logs/meter-usage.jsonl", "utf8")
      : null;
    expect(meterLogAfter).toBe(meterLogBefore);
  },
  { timeout: 120_000 },
);
