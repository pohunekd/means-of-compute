// CLI tests (matrix A9-A11): the CLI rows run the real CLI as a
// spawned process. confirm injection covers the typed-line mismatch;
// the busy row spawns a lock-holder subprocess (AM3-5).
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalsNotConfirmedError,
  runApprovalsCli,
  type ApprovalsCliDeps,
} from "../../src/approvals/cli.js";
import { recordRequest } from "../../src/approvals/store.js";

const APPROVE_ARGS = {
  workItemId: "demo-item",
  pullNumber: 12,
  headSha: "0".repeat(40),
  reason: "Ship the demo item.",
} as const;

interface CliHarness {
  readonly dir: string;
  readonly config: string;
  readonly requests: string;
}

async function writeHarness(): Promise<CliHarness> {
  const dir = await mkdtemp(join(tmpdir(), "approvals-cli-"));
  const requests = join(dir, "approval-requests.json");
  const config = join(dir, "approvals.json");
  await writeFile(
    config,
    JSON.stringify({
      requestsPath: requests,
      operators: ["owner"],
      maxPendingRequests: 20,
      maxReasonChars: 2000,
    }),
    "utf8",
  );
  return { dir, config, requests };
}

function fixedNow(): () => Date {
  return () => new Date("2026-10-26T10:00:00.000Z");
}

async function recordedId(harness: CliHarness): Promise<string> {
  const outcome = await recordRequest(harness.requests, {
    tool: "approve",
    args: { ...APPROVE_ARGS },
    caller: "coordinator",
    now: fixedNow(),
    maxPending: 20,
  });
  if (outcome.kind !== "recorded") {
    throw new Error(`expected recorded, got ${outcome.kind}`);
  }
  return outcome.request.requestId;
}

function deps(confirm: (prompt: string) => Promise<string>): {
  readonly deps: ApprovalsCliDeps;
  readonly out: string[];
  readonly err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const answer = (prompt: string): Promise<string> => confirm(prompt);
  return {
    deps: {
      confirm: answer,
      now: fixedNow(),
      out: (line: string): void => {
        out.push(line);
      },
      err: (line: string): void => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

interface SpawnedCli {
  readonly stdout: string;
  readonly stderr: string;
  readonly rc: number;
}

// A child without a controlling terminal fails fast with the AM3-4 text
// (exit 2), so the decide prompt never blocks on the test's terminal.
const RUN_CLI_TIMEOUT_MS = 4_000;

async function runCli(args: readonly string[]): Promise<SpawnedCli> {
  const child = spawn("bun", ["run", "src/approvals/cli.ts", ...args], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const rc = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `approvals CLI timed out after ${String(RUN_CLI_TIMEOUT_MS)} ms: ${args.join(" ")}`,
        ),
      );
    }, RUN_CLI_TIMEOUT_MS);
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  return { stdout, stderr, rc };
}

async function waitForLine(child: Bun.Subprocess, text: string): Promise<void> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  try {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(`holder exited before printing ${JSON.stringify(text)}`);
      }
      buffer += new TextDecoder().decode(value);
      if (buffer.includes(text)) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

test("list prints one JSON line per pending request", { timeout: 15_000 }, async () => {
  const harness = await writeHarness();
  try {
    const requestId = await recordedId(harness);
    const seen = deps(() => Promise.resolve(requestId));
    const rc = await runApprovalsCli(["list", "--config", harness.config], seen.deps);
    expect(rc).toBe(0);
    expect(seen.out).toHaveLength(1);
    expect(JSON.parse(seen.out[0] as string) as unknown).toMatchObject({
      requestId,
      tool: "approve",
      caller: "coordinator",
    });
    const spawned = await runCli(["list", "--config", harness.config]);
    expect(spawned.rc).toBe(0);
    expect(spawned.stderr).toBe("");
    expect(spawned.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(spawned.stdout) as unknown).toMatchObject({ requestId });
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("decide with a matching confirmation approves the request", async () => {
  const harness = await writeHarness();
  try {
    const requestId = await recordedId(harness);
    const seen = deps(() => Promise.resolve(requestId));
    const rc = await runApprovalsCli(
      ["decide", requestId, "--approve", "--author", "owner", "--config", harness.config],
      seen.deps,
    );
    expect(rc).toBe(0);
    expect(JSON.parse(seen.out[0] as string) as unknown).toMatchObject({
      requestId,
      state: "approved",
      author: "owner",
    });
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test(
  "confirm returns another text: exit 3, file bytes unchanged (A9)",
  {
    timeout: 15_000,
  },
  async () => {
    const harness = await writeHarness();
    try {
      const requestId = await recordedId(harness);
      const before = await readFile(harness.requests, "utf8");
      const seen = deps(() => Promise.resolve("req-009999"));
      const rc = await runApprovalsCli(
        ["decide", requestId, "--approve", "--author", "owner", "--config", harness.config],
        seen.deps,
      );
      expect(rc).toBe(3);
      expect(seen.out).toHaveLength(0);
      expect(await readFile(harness.requests, "utf8")).toBe(before);
      const spawned = await runCli([
        "decide",
        requestId,
        "--approve",
        "--author",
        "owner",
        "--config",
        harness.config,
      ]);
      expect(spawned.rc).toBe(2);
      expect(spawned.stdout).toBe("");
      expect(spawned.stderr).toContain("needs an interactive terminal (/dev/tty)");
    } finally {
      await rm(harness.dir, { recursive: true, force: true });
    }
  },
);

test(
  "--author intruder: exit 2 (A10)",
  {
    timeout: 15_000,
  },
  async () => {
    const harness = await writeHarness();
    try {
      const requestId = await recordedId(harness);
      const seen = deps(() => Promise.resolve(requestId));
      const rc = await runApprovalsCli(
        ["decide", requestId, "--approve", "--author", "intruder", "--config", harness.config],
        seen.deps,
      );
      expect(rc).toBe(2);
      expect(seen.err.join("\n")).toContain("intruder");
      const spawned = await runCli([
        "decide",
        requestId,
        "--approve",
        "--author",
        "intruder",
        "--config",
        harness.config,
      ]);
      expect(spawned.rc).toBe(2);
      expect(spawned.stdout).toBe("");
    } finally {
      await rm(harness.dir, { recursive: true, force: true });
    }
  },
);

test("lock held by a subprocess: exit 3 (A11)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approvals-cli-busy-"));
  const requests = join(dir, "approval-requests.json");
  const config = join(dir, "approvals.json");
  await writeFile(
    config,
    JSON.stringify({
      requestsPath: requests,
      operators: ["owner"],
      maxPendingRequests: 20,
      maxReasonChars: 2000,
    }),
    "utf8",
  );
  const requestId = await recordedId({ dir, config, requests });
  try {
    const before = readFileSync(requests, "utf8");
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "work", "lock-holder.case.ts")], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, WORK_STORE_TEST_PATH: requests },
    });
    try {
      await waitForLine(child, "holder ready");
      const seen = deps(() => Promise.resolve(requestId));
      const rc = await runApprovalsCli(
        ["decide", requestId, "--approve", "--author", "owner", "--config", config],
        seen.deps,
      );
      expect(rc).toBe(3);
      expect(readFileSync(requests, "utf8")).toBe(before);
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage without --approve or --reject exits 2", async () => {
  const harness = await writeHarness();
  try {
    const requestId = await recordedId(harness);
    const seen = deps(() => Promise.resolve(requestId));
    const rc = await runApprovalsCli(
      ["decide", requestId, "--author", "owner", "--config", harness.config],
      seen.deps,
    );
    expect(rc).toBe(2);
    expect(seen.out).toHaveLength(0);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("an unknown request id exits 2", async () => {
  const harness = await writeHarness();
  try {
    await recordedId(harness);
    const seen = deps(() => Promise.resolve("req-009999"));
    const rc = await runApprovalsCli(
      ["decide", "req-009999", "--approve", "--author", "owner", "--config", harness.config],
      seen.deps,
    );
    expect(rc).toBe(2);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("a request removed between the prompt and the write exits 2 as unknown (L1)", async () => {
  const harness = await writeHarness();
  try {
    const requestId = await recordedId(harness);
    const seen = deps(async () => {
      await rm(harness.requests, { force: true });
      return requestId;
    });
    const rc = await runApprovalsCli(
      ["decide", requestId, "--approve", "--author", "owner", "--config", harness.config],
      seen.deps,
    );
    expect(rc).toBe(2);
    expect(seen.out).toHaveLength(0);
    expect(seen.err.join("\n")).toContain(`unknown request "${requestId}"`);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("an already decided request exits 3 as already decided (L1)", async () => {
  const harness = await writeHarness();
  try {
    const requestId = await recordedId(harness);
    const first = deps(() => Promise.resolve(requestId));
    expect(
      await runApprovalsCli(
        ["decide", requestId, "--approve", "--author", "owner", "--config", harness.config],
        first.deps,
      ),
    ).toBe(0);
    const second = deps(() => Promise.resolve(requestId));
    const rc = await runApprovalsCli(
      ["decide", requestId, "--reject", "--author", "owner", "--config", harness.config],
      second.deps,
    );
    expect(rc).toBe(3);
    expect(second.out).toHaveLength(0);
    expect(second.err.join("\n")).toContain("already decided");
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("EOF at the prompt exits 3 as not confirmed (L2)", async () => {
  const harness = await writeHarness();
  try {
    const requestId = await recordedId(harness);
    const before = await readFile(harness.requests, "utf8");
    const seen = deps(() => Promise.reject(new ApprovalsNotConfirmedError()));
    const rc = await runApprovalsCli(
      ["decide", requestId, "--approve", "--author", "owner", "--config", harness.config],
      seen.deps,
    );
    expect(rc).toBe(3);
    expect(seen.out).toHaveLength(0);
    expect(seen.err.join("\n")).toContain(`confirmation for "${requestId}" was not entered`);
    expect(await readFile(harness.requests, "utf8")).toBe(before);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("a confirm I/O error exits 2 and leaves the file byte-identical", async () => {
  const harness = await writeHarness();
  try {
    const requestId = await recordedId(harness);
    const before = await readFile(harness.requests, "utf8");
    const seen = deps(() => Promise.reject(new Error("tty write failed")));
    const rc = await runApprovalsCli(
      ["decide", requestId, "--approve", "--author", "owner", "--config", harness.config],
      seen.deps,
    );
    expect(rc).toBe(2);
    expect(seen.out).toHaveLength(0);
    expect(seen.err.join("\n")).toContain("tty write failed");
    expect(await readFile(harness.requests, "utf8")).toBe(before);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});
