// Adapter config tests (design section 6.2): the config loader rejects a
// missing key, an extra key, each range violation and a bad env name, always
// naming the key; the wait-timeout check and the routes loader behave the
// same. Env names here are variable names only, never secret values.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDispatcherWaitTimeout,
  loadPohunekAdapterConfig,
} from "../../../src/dispatcher/adapter/config.js";
import { loadHostRoutes } from "../../../src/dispatcher/adapter/routes.js";

const VALID = {
  agentProfile: "moc-worker",
  project: "means-of-compute",
  cols: 200,
  rows: 50,
  inputAckTimeoutMs: 8000,
  connectTimeoutMs: 5000,
  cancelWaitTimeoutMs: 30000,
  hostRoutesFileEnv: "MOC_HOST_ROUTES_FILE",
};

async function withTempDir(body: (dir: string) => Promise<unknown>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "moc-adapter-config-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(dir: string, value: unknown): Promise<string> {
  const path = join(dir, "pohunek-adapter.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function writeRoutes(dir: string, value: unknown): Promise<string> {
  const path = join(dir, "routes.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("the checked-in adapter config loads", async () => {
  const config = await loadPohunekAdapterConfig();
  expect(config.agentProfile).toBe("moc-worker");
  expect(config.project).toBe("means-of-compute");
  expect(config.cols).toBe(200);
  expect(config.rows).toBe(50);
  expect(config.inputAckTimeoutMs).toBe(8000);
  expect(config.connectTimeoutMs).toBe(5000);
  expect(config.cancelWaitTimeoutMs).toBe(30000);
  expect(config.hostRoutesFileEnv).toBe("MOC_HOST_ROUTES_FILE");
});

const BAD_CASES: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
  ["missing key", { ...VALID, cols: undefined }, "cols"],
  ["extra key", { ...VALID, extra: 1 }, "extra"],
  ["inputAckTimeoutMs 8001", { ...VALID, inputAckTimeoutMs: 8001 }, "inputAckTimeoutMs"],
  ["cancelWaitTimeoutMs 0", { ...VALID, cancelWaitTimeoutMs: 0 }, "cancelWaitTimeoutMs"],
  ["bad env name", { ...VALID, hostRoutesFileEnv: "lower-case" }, "hostRoutesFileEnv"],
];

for (const [name, value, key] of BAD_CASES) {
  test(`adapter config ${name} throws naming the key`, async () => {
    await withTempDir(async (dir) => {
      const path = await writeConfig(dir, value);
      let message = "";
      try {
        await loadPohunekAdapterConfig(path);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(key);
    });
  });
}

test("checkDispatcherWaitTimeout accepts the turn ceiling and rejects above it", () => {
  checkDispatcherWaitTimeout(86400000);
  let message = "";
  try {
    checkDispatcherWaitTimeout(86400001);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("waitTimeoutMs");
});

test("routes load fails when the env variable is unset", async () => {
  let message = "";
  try {
    await loadHostRoutes("MOC_TEST_ROUTES_UNSET_XYZ", {});
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("MOC_TEST_ROUTES_UNSET_XYZ");
});

test("routes load names a bad alias", async () => {
  await withTempDir(async (dir) => {
    const path = await writeRoutes(dir, { "Bad Alias!": "some-route" });
    let message = "";
    try {
      await loadHostRoutes("MOC_TEST_ROUTES_FILE", { MOC_TEST_ROUTES_FILE: path });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Bad Alias!");
  });
});

test("routes load error never carries the route text", async () => {
  await withTempDir(async (dir) => {
    const path = await writeRoutes(dir, { "Bad Alias!": "peer.example-route" });
    let message = "";
    try {
      await loadHostRoutes("MOC_TEST_ROUTES_FILE", { MOC_TEST_ROUTES_FILE: path });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("peer.example-route");
  });
});
