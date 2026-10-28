// Registry schema rows for a provisional lost entry: a lost terminal
// on a provisional entry (sessionId null) may carry the meter's
// measured usage, so the stranded billing survives. The general
// terminal definitions still apply, so the usage must be a valid
// tokens array.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry, insertRegistryEntry } from "../../src/dispatcher/registry.js";

function provisionalEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "w2-demo:0",
    workItemId: "w2-demo",
    repo: "example/demo",
    hostAlias: "laptop-a",
    branch: "moc/w2-demo",
    baseRef: "origin/main",
    resume: false,
    model: { providerId: "meta-api", model: "muse-spark-1.3-contributor" },
    briefSha256: "a".repeat(64),
    sessionId: null,
    worktree: null,
    baseCommit: null,
    startedAt: "2026-10-27T10:00:00.000Z",
    cursor: null,
    unreachableCount: 1,
    lastSeenState: "starting",
    lastSeenAt: "2026-10-27T10:00:00.000Z",
    cancelReason: null,
    terminal: null,
    resolvedAt: null,
    revision: 0,
    ...overrides,
  };
}

function lostTerminal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "lost",
    observedAt: "2026-10-27T10:00:00.000Z",
    seconds: 0,
    usage: {
      tokens: [
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
          source: "meter-proxy",
        },
      ],
    },
    usageValid: true,
    detail: "unreachable 1 times",
    ledgerAppended: false,
    ...overrides,
  };
}

test("a provisional lost may carry the measured usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-schema-"));
  try {
    const path = join(dir, "registry.json");
    const entry = provisionalEntry({ terminal: lostTerminal() });
    await insertRegistryEntry(path, entry as never);
    const entries = await readRegistry(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.terminal?.usage?.tokens).toEqual([
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        source: "meter-proxy",
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvedAt is required", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-schema-"));
  try {
    const path = join(dir, "registry.json");
    const { resolvedAt: _unused, ...withoutMarker } = provisionalEntry();
    expect(_unused).toBeNull();
    expect(withoutMarker).not.toHaveProperty("resolvedAt");
    let missingMessage = "";
    try {
      await insertRegistryEntry(path, withoutMarker as never);
    } catch (error: unknown) {
      missingMessage = (error as Error).message;
    }
    expect(missingMessage).toContain("invalid registry");
    let invalidMessage = "";
    try {
      await insertRegistryEntry(path, provisionalEntry({ resolvedAt: "x" }) as never);
    } catch (error: unknown) {
      invalidMessage = (error as Error).message;
    }
    expect(invalidMessage).toContain("invalid registry");
    const nullPath = join(dir, "registry-null.json");
    await insertRegistryEntry(nullPath, provisionalEntry({ resolvedAt: null }) as never);
    expect(await readRegistry(nullPath)).toHaveLength(1);
    const isoPath = join(dir, "registry-iso.json");
    await insertRegistryEntry(
      isoPath,
      provisionalEntry({ resolvedAt: "2026-10-27T10:00:00.000Z" }) as never,
    );
    expect(await readRegistry(isoPath)).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provisional entry with a finished terminal is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-schema-"));
  try {
    const path = join(dir, "registry.json");
    const entry = provisionalEntry({
      terminal: lostTerminal({ state: "finished" }),
    });
    let message = "";
    try {
      await insertRegistryEntry(path, entry as never);
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain("invalid registry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provisional entry with a worktree is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-schema-"));
  try {
    const path = join(dir, "registry.json");
    const entry = provisionalEntry({
      worktree: "/tmp/somewhere",
      terminal: lostTerminal(),
    });
    let message = "";
    try {
      await insertRegistryEntry(path, entry as never);
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain("invalid registry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
