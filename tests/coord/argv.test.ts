// Muse argv tests (A1-A3): the plan literal, the react phase switch and the
// redacted export.
import { expect, test } from "bun:test";
import { exportArgv, factoryEntry, museArgv, type MuseSession } from "../../src/coord/argv.js";
import { loadCoordConfig } from "../../src/coord/config.js";

const SESSION: MuseSession = {
  kind: "plan",
  k: 1,
  sessionId: "0b7e6f52-3c1d-4e8a-9f20-6a5d4c3b2a19",
  runDir: "/srv/moc/logs/coord-runs/20261028T100000Z-notes-abcdef",
  checkoutDir: "/srv/moc",
  bunPath: "/opt/bun/bin/bun",
};

const R = SESSION.runDir;

test("the plan argv matches the pinned flags (A1)", async () => {
  const { config } = await loadCoordConfig("config/coordinator.json");
  expect(museArgv(config, SESSION)).toEqual([
    "muse",
    "exec",
    "--json",
    "--prompt-file",
    `${R}/prompt-1.md`,
    "--api-key-stdin",
    "--provider",
    "meta",
    "--model",
    "muse-spark-1.3-contributor",
    "--contributor-mode",
    "on",
    "--reasoning-effort",
    "high",
    "--max-model-steps",
    "40",
    "--max-tool-output-bytes",
    "65536",
    "--no-parallel-tool-calls",
    "--session-id",
    "0b7e6f52-3c1d-4e8a-9f20-6a5d4c3b2a19",
    "--workspace",
    `${R}/workspace`,
    "--approval-mode",
    "never",
    "--approval-judge",
    "off",
    "--disable-shell",
    "--disable-write",
    "--disable-web-tools",
    "--disable-reminders",
    "--disable-request-user-input",
    "--no-foreign-personal-context",
    "-c",
    'mcpServers.factory={"command":"/opt/bun/bin/bun","args":["--cwd=/srv/moc","src/mcp/serve.ts","--caller","coordinator","--config","/srv/moc/logs/coord-runs/20261028T100000Z-notes-abcdef/mcp.json"]}',
  ]);
});

test("the react session uses the react phase (A2)", async () => {
  const { config } = await loadCoordConfig("config/coordinator.json");
  const session: MuseSession = { ...SESSION, kind: "react", k: 2 };
  const argv = museArgv(config, session);
  const promptIndex = argv.indexOf("--prompt-file");
  expect(argv[promptIndex + 1]).toBe(`${R}/prompt-2.md`);
  const effortIndex = argv.indexOf("--reasoning-effort");
  expect(argv[effortIndex + 1]).toBe("medium");
  const stepsIndex = argv.indexOf("--max-model-steps");
  expect(argv[stepsIndex + 1]).toBe("20");
  const factoryArg = argv[argv.length - 1] as string;
  expect(factoryArg.startsWith("mcpServers.factory=")).toBe(true);
  expect(JSON.parse(factoryArg.slice("mcpServers.factory=".length)) as unknown).toEqual({
    command: "/opt/bun/bin/bun",
    args: [
      "--cwd=/srv/moc",
      "src/mcp/serve.ts",
      "--caller",
      "coordinator",
      "--config",
      `${R}/mcp.json`,
    ],
  });
  expect(factoryEntry(session)).toEqual({
    command: "/opt/bun/bin/bun",
    args: [
      "--cwd=/srv/moc",
      "src/mcp/serve.ts",
      "--caller",
      "coordinator",
      "--config",
      `${R}/mcp.json`,
    ],
  });
});

test("the export argv stays redacted (A3)", async () => {
  const { config } = await loadCoordConfig("config/coordinator.json");
  expect(exportArgv(config, SESSION)).toEqual([
    "muse",
    "export",
    "--session",
    "0b7e6f52-3c1d-4e8a-9f20-6a5d4c3b2a19",
    "--redacted",
    "--out",
    `${R}/session-1-export.json`,
  ]);
});
