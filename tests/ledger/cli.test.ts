// Ledger CLI smoke test: record writes a pending line, query lists it,
// finalize folds it into one record line and query still lists it.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(REPO, "src", "ledger", "cli.ts");

async function runLedger(
  dir: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("CLI: record then query then finalize then query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-cli-"));
  try {
    const configPath = join(dir, "ledger.json");
    const ledgerPath = join(dir, "ledger.jsonl");
    await Bun.write(configPath, JSON.stringify({ ledgerPath }));
    await Bun.write(
      join(dir, "pending.json"),
      JSON.stringify({
        entryId: "e1-smoke",
        kind: "session",
        workItemId: "w1-smoke",
        finishedAt: "2026-10-26T12:00:00.000Z",
        startModel: "muse-spark-1.3-contributor",
        tokens: [
          {
            provider: "meta-api",
            model: "muse-spark-1.3-contributor",
            inputTokens: 100,
            outputTokens: 50,
            requests: 3,
            source: "provider-usage",
          },
        ],
        session: {
          hostAlias: "desktop",
          seconds: 60,
          source: "dispatcher-clock",
          result: "success",
        },
      }),
    );
    const recorded = await runLedger(dir, [
      "record",
      "--config",
      configPath,
      "--pending-file",
      join(dir, "pending.json"),
    ]);
    expect(`${recorded.stdout}${recorded.stderr}`).toContain("recorded e1-smoke for w1-smoke");
    expect(recorded.code).toBe(0);
    const listed = await runLedger(dir, ["query", "--config", configPath]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("w1-smoke");
    const finalized = await runLedger(dir, [
      "finalize",
      "--config",
      configPath,
      "--work-item-id",
      "w1-smoke",
      "--result",
      "success",
      "--retries",
      "0",
      "--human-interventions",
      "0",
    ]);
    expect(finalized.code).toBe(0);
    expect(finalized.stdout).toContain("appended w1-smoke");
    const listedAgain = await runLedger(dir, ["query", "--config", configPath]);
    expect(listedAgain.code).toBe(0);
    expect(listedAgain.stdout).toContain("w1-smoke");
    const lines = (await Bun.file(ledgerPath).text()).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).not.toHaveProperty("pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
