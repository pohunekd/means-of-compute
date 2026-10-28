// Host token helper tests: the helper reads the meter token from the
// session metadata of its own session and prints exactly the token.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HELPER = resolve("scripts/host/meter-token.mjs");
const FIXTURE_BIN = resolve("tests/fixtures/meter/bin");

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runHelper(env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, HELPER], {
    env: { PATH: env["PATH"] ?? "", HOME: env["HOME"] ?? "", ...env },
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

function baseEnv(argsFile: string, tokenFixture = ""): Record<string, string> {
  return {
    PATH: `${FIXTURE_BIN}:${process.env["PATH"] ?? ""}`,
    HOME: process.env["HOME"] ?? "",
    MOC_METER_TOKEN_TIMEOUT_MS: "60000",
    POHUNEK_SESSION_ID: "s-01TEST",
    FAKE_POHUNEK_MODE: "ok",
    FAKE_POHUNEK_ARGS_FILE: argsFile,
    FAKE_POHUNEK_TOKEN: tokenFixture,
  };
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "host-token-"));
}

test("prints exactly the token from the session metadata", async () => {
  const dir = scratchDir();
  try {
    const argsFile = join(dir, "args");
    const token = `moc1.w1-demo-0.${"a".repeat(43)}`;
    const result = await runHelper({ ...baseEnv(argsFile), FAKE_POHUNEK_TOKEN: token });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(token);
    expect(result.stderr).toBe("");
    expect(await Bun.file(argsFile).text()).toBe("session\ninspect\ns-01TEST\n--json\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing metadata exits 1 without the token", async () => {
  const dir = scratchDir();
  try {
    const argsFile = join(dir, "args");
    const result = await runHelper({ ...baseEnv(argsFile), FAKE_POHUNEK_MODE: "missing" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("meter-token: no meter token in session metadata\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed token exits 1", async () => {
  const dir = scratchDir();
  try {
    const argsFile = join(dir, "args");
    const result = await runHelper({ ...baseEnv(argsFile), FAKE_POHUNEK_MODE: "malformed" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("meter-token: meter token is malformed\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-JSON output exits 1", async () => {
  const dir = scratchDir();
  try {
    const argsFile = join(dir, "args");
    const result = await runHelper({ ...baseEnv(argsFile), FAKE_POHUNEK_MODE: "bad-json" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("meter-token: inspect output is not JSON\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing pohunek exits 1 and hides its stderr", async () => {
  const dir = scratchDir();
  try {
    const argsFile = join(dir, "args");
    const result = await runHelper({ ...baseEnv(argsFile), FAKE_POHUNEK_MODE: "fail" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("meter-token: pohunek exited 1\n");
    expect(result.stderr).not.toContain("session_not_found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hanging pohunek times out", async () => {
  const dir = scratchDir();
  try {
    const argsFile = join(dir, "args");
    const result = await runHelper({
      ...baseEnv(argsFile),
      FAKE_POHUNEK_MODE: "hang",
      MOC_METER_TOKEN_TIMEOUT_MS: "200",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("meter-token: pohunek timed out\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing env exits 1 naming the variable", async () => {
  const dir = scratchDir();
  try {
    const argsFile = join(dir, "args");
    const unsetEnv = { ...baseEnv(argsFile) };
    delete unsetEnv["POHUNEK_SESSION_ID"];
    const unset = await runHelper(unsetEnv);
    expect(unset.code).toBe(1);
    expect(unset.stdout).toBe("");
    expect(unset.stderr).toBe("meter-token: POHUNEK_SESSION_ID is not set\n");
    expect(await Bun.file(argsFile).exists()).toBe(false);
    const badTimeout = await runHelper({
      ...baseEnv(argsFile),
      MOC_METER_TOKEN_TIMEOUT_MS: "0",
      FAKE_POHUNEK_MODE: "ok",
    });
    expect(badTimeout.code).toBe(1);
    expect(badTimeout.stdout).toBe("");
    expect(badTimeout.stderr).toBe("meter-token: MOC_METER_TOKEN_TIMEOUT_MS is invalid\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no pohunek on PATH exits 1", async () => {
  const dir = scratchDir();
  try {
    const emptyBin = join(dir, "empty-bin");
    await Bun.$`mkdir -p ${emptyBin}`.quiet();
    const result = await runHelper({
      PATH: emptyBin,
      HOME: process.env["HOME"] ?? "",
      POHUNEK_SESSION_ID: "s-01TEST",
      MOC_METER_TOKEN_TIMEOUT_MS: "60000",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("meter-token: pohunek failed to start\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
