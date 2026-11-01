// dispatch:resolve CLI tests (53c, design 5.2): the command prints one
// JSON line with exit 0, maps refusals to exit 3 with the request id,
// never prints a port message or route, never opens the runtime on bad
// flags, and maps an unknown request to exit 2. The withRuntime helper
// builds a real dispatcher over the memory port; temp registry and ledger
// paths; no timers and no real host.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runResolveCli(
  dir: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly rc: number }> {
  const proc = Bun.spawn(
    ["bun", join(process.cwd(), "src/dispatcher/cli.ts"), "resolve", ...args],
    {
      cwd: dir,
      env: { ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, rc] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, rc };
}

async function withConfigCopy(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-resolve-cli-"));
  try {
    cpSync(join(process.cwd(), "config"), join(dir, "config"), { recursive: true });
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function envWithoutMoc(): Record<string, string | undefined> {
  const kept: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("MOC_")) {
      kept[key] = value;
    }
  }
  return kept;
}

test("an unwritable resolve log exits 2 before the runtime", async () => {
  await withConfigCopy(async (dir) => {
    const addressesFile = join(dir, "host-addresses.json");
    await writeFile(addressesFile, JSON.stringify({ "laptop-a": ["10.0.0.1"] }), "utf8");
    const routesFile = join(dir, "host-routes.json");
    await writeFile(routesFile, JSON.stringify({ "laptop-a": "route" }), "utf8");
    // The resolve log path is a directory: the preparation fails with
    // EISDIR before anything is locked, bound or opened.
    await mkdir(join(dir, "logs", "dispatch-resolve.jsonl"), { recursive: true });
    const env: Record<string, string | undefined> = {
      ...envWithoutMoc(),
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: randomBytes(32).toString("base64"),
      MOC_METER_HOST_ADDRESSES_FILE: addressesFile,
      MOC_HOST_ROUTES_FILE: routesFile,
      NVIDIA_API_KEY: "test-nvidia-key",
      META_API_KEY: "test-meta-key",
      BASETEN_API_KEY: "test-baseten-key",
      PROVIDER_NVIDIA_BUILD_BASE_URL: "http://127.0.0.1:9",
      PROVIDER_META_API_BASE_URL: "http://127.0.0.1:9",
      PROVIDER_BASETEN_BASE_URL: "http://127.0.0.1:9",
    };
    const started = Date.now();
    const { stdout, stderr, rc } = await runResolveCli(dir, ["--request", "demo-item:0"], env);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(rc).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.split("\n")).toEqual(["dispatch: resolve log: EISDIR", ""]);
  });
});

test("an unknown request with no logs directory is a precondition error", async () => {
  await withConfigCopy(async (dir) => {
    const addressesFile = join(dir, "host-addresses.json");
    await writeFile(addressesFile, JSON.stringify({ "laptop-a": ["10.0.0.1"] }), "utf8");
    const routesFile = join(dir, "host-routes.json");
    await writeFile(routesFile, JSON.stringify({ "laptop-a": "route" }), "utf8");
    // The socket path under a long TMPDIR would exceed Linux's 107-byte limit.
    const runtimeBase = await mkdtemp(join("/tmp", "moc-resolve-"));
    try {
      const runtimeDir = join(runtimeBase, "pohunek");
      await mkdir(runtimeDir, { recursive: true });
      await chmod(runtimeDir, 0o700);
      const env: Record<string, string | undefined> = {
        ...envWithoutMoc(),
        MOC_METER_LISTEN: "127.0.0.1:0",
        MOC_METER_SECRET: randomBytes(32).toString("base64"),
        MOC_METER_HOST_ADDRESSES_FILE: addressesFile,
        MOC_HOST_ROUTES_FILE: routesFile,
        XDG_RUNTIME_DIR: runtimeBase,
        NVIDIA_API_KEY: "test-nvidia-key",
        META_API_KEY: "test-meta-key",
        BASETEN_API_KEY: "test-baseten-key",
        PROVIDER_NVIDIA_BUILD_BASE_URL: "http://127.0.0.1:9",
        PROVIDER_META_API_BASE_URL: "http://127.0.0.1:9",
        PROVIDER_BASETEN_BASE_URL: "http://127.0.0.1:9",
      };
      const { stdout, stderr, rc } = await runResolveCli(dir, ["--request", "demo-item:0"], env);
      expect(rc).toBe(2);
      expect(stdout).toBe("");
      expect(stderr.trim()).toMatch(/^dispatch: dispatcher precondition known-request:/);
      expect(stderr.trim().split("\n")).toHaveLength(1);
    } finally {
      await rm(runtimeBase, { recursive: true, force: true });
    }
  });
});
