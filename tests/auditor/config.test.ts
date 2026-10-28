// Auditor config tests (C1-C6): the committed config loads the merge
// auditor, and every mergeAuditor rule (2.2) rejects its own malformed
// temp auditor.json read from the repository cwd. Each test names the
// mutation that must fail it.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuditorConfig } from "../../src/auditor/config.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WONDER = { providerId: "meta-wonder", model: "muse-wonder-1.0" };

async function tempAuditorJson(mergeAuditor: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "auditor-config-"));
  const committed = JSON.parse(
    await Bun.file(join(REPO_ROOT, "config", "auditor.json")).text(),
  ) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...committed };
  if (mergeAuditor === undefined) {
    Reflect.deleteProperty(next, "mergeAuditor");
  } else {
    next["mergeAuditor"] = mergeAuditor;
  }
  const path = join(dir, "auditor.json");
  await Bun.write(path, `${JSON.stringify(next)}\n`);
  return path;
}

async function loadFails(path: string): Promise<string> {
  let message = "";
  try {
    await loadAuditorConfig(path);
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
  expect(message).not.toBe("");
  return message;
}

test("C1: committed config loads the merge auditor (mutation: drop mergeAuditor from the returned object)", async () => {
  const config = await loadAuditorConfig();
  expect(config.mergeAuditor).toEqual(WONDER);
  expect(config.auditors.some((entry) => entry.model === WONDER.model)).toBe(false);
});

test("C2: missing mergeAuditor exits 2 (mutation: remove mergeAuditor from ALLOWED_KEYS)", async () => {
  const message = await loadFails(await tempAuditorJson(undefined));
  expect(message).toContain('missing required key "mergeAuditor"');
});

test("C3: a route provider is refused as merge auditor (mutation: drop rule 4)", async () => {
  const message = await loadFails(
    await tempAuditorJson({ providerId: "nvidia-build", model: "meta/muse-glimmer-30b" }),
  );
  expect(message).toContain(
    'mergeAuditor provider "nvidia-build" must not be in config/providers/route.json',
  );
});

test("C4: a zero-priced merge auditor is refused (mutation: drop rule 7)", async () => {
  const message = await loadFails(
    await tempAuditorJson({ providerId: "local", model: "local-model" }),
  );
  expect(message).toContain(
    "mergeAuditor provider file config/providers/local.json must price inputPer1M and outputPer1M above 0",
  );
});

test("C5: a model mismatch is refused (mutation: skip the descriptor model check)", async () => {
  const message = await loadFails(
    await tempAuditorJson({ providerId: "meta-wonder", model: "muse-wonder-1.1" }),
  );
  expect(message).toContain("mergeAuditor.model does not match config/providers/meta-wonder.json");
});

test("C6: the Wonder descriptor carries the cited price and stays off the route (mutation: change any price)", async () => {
  const descriptor = JSON.parse(
    await Bun.file(join(REPO_ROOT, "config", "providers", "meta-wonder.json")).text(),
  ) as unknown;
  expect(descriptor).toEqual({
    id: "meta-wonder",
    name: "Meta Model API (Muse Wonder)",
    baseUrl: "https://api.meta.ai/v1",
    model: "muse-wonder-1.0",
    apiKeyEnv: "META_API_KEY",
    timeoutMs: 600000,
    pricing: {
      inputPer1M: 4,
      cachedInputPer1M: 0.2,
      outputPer1M: 20,
    },
  });
  const route = JSON.parse(
    await Bun.file(join(REPO_ROOT, "config", "providers", "route.json")).text(),
  ) as { providers: string[] };
  expect(route.providers).not.toContain("meta-wonder");
});
