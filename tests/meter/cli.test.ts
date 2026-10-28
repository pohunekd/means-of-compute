// CLI tests for meter:usage: the join prints as one JSON line, an
// unknown grant exits 3, and bad flags or a bad log exit 2.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openBoundGrant, withMeter } from "./helpers.js";

const SCRIPT = resolve("src/meter/cli.ts");

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function chatBody(): Record<string, unknown> {
  return {
    model: "moc-session",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
}

test("meter:usage prints the join, exits 3 without a grant", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter, logPath }) => {
    const { requestId } = await openBoundGrant(meter);
    const resp = await fetch(`http://127.0.0.1:${String(meter.port)}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${meter.tokenFor(requestId)}`,
      },
      body: JSON.stringify(chatBody()),
    });
    expect(resp.status).toBe(200);
    await resp.text();
    const settled = await meter.settleRequest(requestId, "finished");
    if (settled === null) {
      throw new Error("expected a settled join");
    }
    const before = await Bun.file(logPath).bytes();
    const printed = await runCli(["usage", "--log", logPath, "--request", requestId]);
    expect(printed.code).toBe(0);
    expect(printed.stdout.trim()).toBe(JSON.stringify(settled));
    const after = await Bun.file(logPath).bytes();
    expect(after).toEqual(before);
    const missing = await runCli(["usage", "--log", logPath, "--request", "w9-demo:0"]);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain("meter: no grant for w9-demo:0");
    // A torn tail is ignored and the file is unchanged (bytes equal).
    await Bun.write(logPath, `${await Bun.file(logPath).text()}{"kind":"grant-`);
    const tailBytes = await Bun.file(logPath).bytes();
    const torn = await runCli(["usage", "--log", logPath, "--request", requestId]);
    expect(torn.code).toBe(0);
    expect(torn.stdout.trim()).toBe(JSON.stringify(settled));
    expect(await Bun.file(logPath).bytes()).toEqual(tailBytes);
  });
});

test("meter:usage exits 2 on a bad flag or log", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ logPath }) => {
    const missing = await runCli(["usage", "--log", logPath]);
    expect(missing.code).toBe(2);
    expect(missing.stderr.split("\n")).toHaveLength(2);
    expect(missing.stderr).toStartWith("meter:");
    const unknown = await runCli(["usage", "--log", logPath, "--request", "w1-demo:0", "--x", "1"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toStartWith("meter:");
    const repeated = await runCli([
      "usage",
      "--log",
      logPath,
      "--log",
      logPath,
      "--request",
      "w1-demo:0",
    ]);
    expect(repeated.code).toBe(2);
    expect(repeated.stderr).toStartWith("meter:");
    const dir = mkdtempSync(join(tmpdir(), "meter-cli-"));
    try {
      const badLog = join(dir, "bad.jsonl");
      await Bun.write(badLog, "not json\n");
      const before = await Bun.file(badLog).bytes();
      const bad = await runCli(["usage", "--log", badLog, "--request", "w1-demo:0"]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toStartWith("meter:");
      expect(await Bun.file(badLog).bytes()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
