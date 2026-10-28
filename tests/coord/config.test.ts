// Coordinator config tests (C1-C13): missing keys, literal pins, guard
// exclusions, seed shapes, committed bytes and the unexpected-key rule.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordConfigError, loadCoordConfig, type CoordConfig } from "../../src/coord/config.js";

const COMMITTED = "config/coordinator.json";

async function readCommitted(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(COMMITTED, "utf8")) as Record<string, unknown>;
}

async function tempConfig(
  mutate: (value: Record<string, unknown>) => void,
): Promise<{ dir: string; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), "coord-config-"));
  const committed = await readCommitted();
  mutate(committed);
  const path = join(dir, "coordinator.json");
  await Bun.write(path, `${JSON.stringify(committed, null, 2)}\n`);
  return { dir, path };
}

async function fails(path: string, message: string): Promise<void> {
  let error: unknown;
  try {
    await loadCoordConfig(path);
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CoordConfigError);
  expect((error as Error).message).toBe(`Coordinator config ${path}: ${message}`);
}

test("a missing plan limit names it (C1)", async () => {
  const { dir, path } = await tempConfig((value) => {
    delete (value["plan"] as Record<string, unknown>)["maxModelSteps"];
  });
  try {
    await fails(path, 'missing required key "plan.maxModelSteps"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a disabled contributor mode is invalid (C2)", async () => {
  const { dir, path } = await tempConfig((value) => {
    value["contributorMode"] = "off";
  });
  try {
    await fails(path, 'invalid required key "contributorMode"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mistyped model is invalid (C3)", async () => {
  const { dir, path } = await tempConfig((value) => {
    value["model"] = "muse-spark-1.3";
  });
  try {
    await fails(path, 'invalid required key "model"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passing the key variable through is invalid (C4)", async () => {
  const { dir, path } = await tempConfig((value) => {
    value["envPassthrough"] = ["PATH", "META_API_KEY"];
  });
  try {
    await fails(path, 'invalid required key "envPassthrough"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a renamed provider fails even with a matching model (C5)", async () => {
  const { dir, path } = await tempConfig((value) => {
    value["providerId"] = "meta-wonder";
    value["model"] = "muse-wonder-1.0";
  });
  try {
    await fails(path, 'invalid required key "providerId"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HOME and XDG entries are invalid (C6)", async () => {
  const home = await tempConfig((value) => {
    value["envPassthrough"] = ["PATH", "HOME"];
  });
  try {
    await fails(home.path, 'invalid required key "envPassthrough"');
  } finally {
    rmSync(home.dir, { recursive: true, force: true });
  }
  const xdg = await tempConfig((value) => {
    value["envPassthrough"] = ["PATH", "XDG_CONFIG_HOME"];
  });
  try {
    await fails(xdg.path, 'invalid required key "envPassthrough"');
  } finally {
    rmSync(xdg.dir, { recursive: true, force: true });
  }
});

test("seed state dirs stay inside coord runs (C7)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-config-"));
  try {
    const base = await readCommitted();
    for (const stateDir of ["logs/other", `${dir}/other`, `${dir}/coord-a/../coord-b`]) {
      const path = join(dir, "coordinator.json");
      await Bun.write(
        path,
        `${JSON.stringify({ ...base, seed: { stateDir, storeSeedPath: null } }, null, 2)}\n`,
      );
      await fails(path, 'invalid required key "seed.stateDir"');
    }
    const okDir = `${dir}/coord-a`;
    const okPath = join(dir, "coordinator.json");
    await Bun.write(
      okPath,
      `${JSON.stringify({ ...base, seed: { stateDir: okDir, storeSeedPath: null } }, null, 2)}\n`,
    );
    const loaded = await loadCoordConfig(okPath);
    expect(loaded.config.seed).toEqual({ stateDir: okDir, storeSeedPath: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch bounds accept the edge and refuse beyond it (C8)", async () => {
  const edge = await tempConfig((value) => {
    (value["watch"] as Record<string, unknown>)["deadlineMs"] = 1000;
  });
  try {
    const loaded = await loadCoordConfig(edge.path);
    expect(loaded.config.watch.deadlineMs).toBe(1000);
  } finally {
    rmSync(edge.dir, { recursive: true, force: true });
  }
  const low = await tempConfig((value) => {
    (value["watch"] as Record<string, unknown>)["deadlineMs"] = 999;
  });
  try {
    await fails(low.path, 'invalid required key "watch.deadlineMs"');
  } finally {
    rmSync(low.dir, { recursive: true, force: true });
  }
  const high = await tempConfig((value) => {
    (value["react"] as Record<string, unknown>)["maxEntries"] = 11;
  });
  try {
    await fails(high.path, 'invalid required key "react.maxEntries"');
  } finally {
    rmSync(high.dir, { recursive: true, force: true });
  }
});

test("the committed config hashes from its bytes (C9)", async () => {
  const loaded = await loadCoordConfig(COMMITTED);
  const text = await readFile(COMMITTED, "utf8");
  expect(loaded.configSha256).toBe(createHash("sha256").update(text).digest("hex"));
});

test("the committed config loads with its pinned values (C10)", async () => {
  const loaded = await loadCoordConfig(COMMITTED);
  expect(loaded.config).toEqual({
    museCommand: ["muse"],
    providerId: "meta-api",
    model: "muse-spark-1.3-contributor",
    contributorMode: "on",
    approvalMode: "never",
    envPassthrough: ["PATH"],
    mcpConfigPath: "config/mcp.json",
    budgetGateConfigPath: "config/budget-gate.json",
    skillDir: ".agents/skills/factory-coord",
    runsDir: "logs/coord-runs",
    maxRunsPerDay: 4,
    maxOutcomeChars: 8000,
    maxToolOutputBytes: 65536,
    killGraceMs: 10000,
    exportTimeoutMs: 60000,
    plan: {
      reasoningEffort: "high",
      maxModelSteps: 40,
      maxSubmitAttempts: 4,
      timeoutMs: 1200000,
    },
    react: {
      reasoningEffort: "medium",
      maxModelSteps: 20,
      maxSubmitPerEntry: 2,
      maxEntries: 3,
      timeoutMs: 600000,
    },
    watch: {
      pollMs: 60000,
      deadlineMs: 28800000,
      maxReactSessions: 8,
      maxFailedSessions: 2,
      maxPollErrors: 5,
      maxFollowupsPerRun: 6,
      pauseRequestBlockedItems: 3,
    },
    seed: null,
  } satisfies CoordConfig);
  expect(loaded.apiKeyEnv).toBe("META_API_KEY");
  expect(loaded.mcp.callers).toEqual(["coordinator", "mcp-call"]);
  expect(loaded.skill.body.startsWith("# Factory coordination")).toBe(true);
});

test("a skill without frontmatter wraps its loader error (C11)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-config-"));
  try {
    const skillDir = join(dir, "skill");
    await Bun.write(join(skillDir, "SKILL.md"), "no frontmatter\n");
    const { dir: configDir, path } = await tempConfig((value) => {
      value["skillDir"] = skillDir;
    });
    try {
      await fails(
        path,
        `invalid required key "skillDir" (Skill ${skillDir}/SKILL.md: missing frontmatter)`,
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an mcp config without the coordinator caller is invalid (C12)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-config-"));
  try {
    const mcp = JSON.parse(await readFile("config/mcp.json", "utf8")) as Record<string, unknown>;
    mcp["callers"] = ["mcp-call"];
    const mcpPath = join(dir, "mcp.json");
    await Bun.write(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
    const { dir: configDir, path } = await tempConfig((value) => {
      value["mcpConfigPath"] = mcpPath;
    });
    try {
      await fails(
        path,
        'invalid required key "mcpConfigPath" (callers must include coordinator and mcp-call)',
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an extra top-level key is unexpected (C13)", async () => {
  const { dir, path } = await tempConfig((value) => {
    value["evidenceDenyPatterns"] = [];
  });
  try {
    await fails(path, 'unexpected key "evidenceDenyPatterns"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
