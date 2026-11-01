// Snapshot CLI tests: the page is rendered from the given files with the
// clock fixed at --as-of, byte-identical across runs, the Fleet shows the
// newest recorded host-state probe per alias at or before --as-of, and a
// host name from the host map anywhere in the page exits 3 without writing
// the file.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPending, finalizeUsage } from "../../src/ledger/store.js";

const AS_OF = "2026-10-28T12:00:00.000Z";

async function seedLedger(ledgerPath: string, hostAlias: string): Promise<void> {
  await appendPending(ledgerPath, {
    entryId: "e1-session",
    kind: "session",
    workItemId: "w1-demo",
    finishedAt: "2026-10-28T10:40:00.000Z",
    startModel: "meta/muse-glimmer-30b",
    tokens: [
      {
        provider: "nvidia-build",
        model: "meta/muse-glimmer-30b",
        inputTokens: 1000,
        outputTokens: 500,
        requests: 2,
        source: "provider-usage",
      },
    ],
    session: { hostAlias, seconds: 540, source: "dispatcher-clock", result: "success" },
  });
  await finalizeUsage(ledgerPath, {
    workItemId: "w1-demo",
    result: "success",
    retries: 0,
    humanInterventions: 0,
  });
}

async function runSnapshot(dir: string, out: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "src/factory/snapshot.ts",
      "--as-of",
      AS_OF,
      "--out",
      out,
      "--ledger",
      join(dir, "ledger.jsonl"),
      "--verdicts",
      join(dir, "verdicts"),
      "--registry",
      join(dir, "registry.json"),
      "--results",
      join(dir, "results.jsonl"),
      "--work",
      join(dir, "work-items.json"),
      "--ports",
      join(dir, "loop-ports.jsonl"),
      "--hosts",
      join(dir, "hosts.json"),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

test("a snapshot renders the given files at --as-of and is byte-identical across runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-snapshot-"));
  try {
    await seedLedger(join(dir, "ledger.jsonl"), "desktop");
    writeFileSync(join(dir, "hosts.json"), JSON.stringify({ "build-box-7": "desktop" }));
    const first = await runSnapshot(dir, join(dir, "first.html"));
    const second = await runSnapshot(dir, join(dir, "second.html"));
    expect([first.code, second.code]).toEqual([0, 0]);
    const page = readFileSync(join(dir, "first.html"), "utf8");
    expect(page).toBe(readFileSync(join(dir, "second.html"), "utf8"));
    expect(page).toContain(`<time datetime="${AS_OF}" title="${AS_OF}">`);
    expect(page).toContain("w1-demo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host name from the host map in the page exits 3 and writes no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-snapshot-"));
  try {
    await seedLedger(join(dir, "ledger.jsonl"), "build-box-7");
    writeFileSync(join(dir, "hosts.json"), JSON.stringify({ "build-box-7": "desktop" }));
    const result = await runSnapshot(dir, join(dir, "page.html"));
    expect(result.code).toBe(3);
    expect(result.stderr).toBe(
      "dashboard:snapshot: page contains the host name mapped to alias desktop\n",
    );
    expect(existsSync(join(dir, "page.html"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function probe(ts: string, hostAlias: string, cause: string | null): string {
  return JSON.stringify({
    ts,
    source: "host-state",
    event: "host-state",
    hostAlias,
    kind: cause === null ? "reported" : "unavailable",
    cause,
    detail: cause === null ? null : `${cause} (private_detail_text)`,
    packageVersion: null,
    packageDigest: null,
    durationMs: 12,
    stdoutBytes: null,
    stdoutSha256: null,
  });
}

test("the fleet shows the newest recorded probe per alias at or before --as-of", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-snapshot-"));
  try {
    await seedLedger(join(dir, "ledger.jsonl"), "desktop");
    writeFileSync(
      join(dir, "loop-ports.jsonl"),
      [
        JSON.stringify({ ts: "2026-10-28T09:00:00.000Z", source: "meter", event: "tick" }),
        probe("2026-10-28T10:00:00.000Z", "desktop", null),
        probe("2026-10-28T11:00:00.000Z", "laptop-b", "daemon-rejected"),
        probe("2026-10-28T13:00:00.000Z", "desktop", "host-unreachable"),
        '{"ts":"2026-10-28T11:30:00.000Z","source":"host-state","hostAlias":"Build',
      ].join("\n"),
    );
    const result = await runSnapshot(dir, join(dir, "page.html"));
    expect(result.code).toBe(0);
    const page = readFileSync(join(dir, "page.html"), "utf8");
    const fleet = page.slice(
      page.indexOf('<section id="fleet">'),
      page.indexOf('<section id="work">'),
    );
    expect(fleet).toContain("last probe: reported");
    expect(fleet).toContain('datetime="2026-10-28T10:00:00.000Z"');
    expect(fleet).toContain("last probe: unavailable: daemon rejected the request");
    expect(fleet).toContain('datetime="2026-10-28T11:00:00.000Z"');
    expect(fleet).toContain("no data (capacity values are not recorded)");
    expect(fleet).toContain(
      "a snapshot has no live host state: state and observed are the newest probe recorded at or before 2026-10-28T12:00:00.000Z",
    );
    expect(fleet).not.toContain("unreachable");
    expect(page).not.toContain("private_detail_text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host-state line with an invalid alias exits 2 without the value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-snapshot-"));
  try {
    await seedLedger(join(dir, "ledger.jsonl"), "desktop");
    writeFileSync(
      join(dir, "loop-ports.jsonl"),
      `${probe("2026-10-28T10:00:00.000Z", "Build Box", null)}\n`,
    );
    const result = await runSnapshot(dir, join(dir, "page.html"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("input hosts host-state-log-invalid: host-state log ");
    expect(result.stderr).toContain("loop-ports.jsonl: line 1: invalid hostAlias");
    expect(result.stderr).not.toContain("Build Box");
    expect(existsSync(join(dir, "page.html"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
