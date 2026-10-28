// Muse argv builders: the launcher entry runs the MCP server under bun with
// the coordinator caller; the exec and export commands carry the pinned
// flags. All three functions are pure.
import { join } from "node:path";
import { COORDINATOR_CALLER } from "./calls.js";
import type { CoordConfig } from "./config.js";

export interface MuseSession {
  readonly kind: "plan" | "react";
  readonly k: number;
  readonly sessionId: string;
  readonly runDir: string;
  readonly checkoutDir: string;
  readonly bunPath: string;
}

export interface FactoryEntry {
  readonly command: string;
  readonly args: readonly string[];
}

export function factoryEntry(session: MuseSession): FactoryEntry {
  return {
    command: session.bunPath,
    args: [
      `--cwd=${session.checkoutDir}`,
      "src/mcp/serve.ts",
      "--caller",
      COORDINATOR_CALLER,
      "--config",
      join(session.runDir, "mcp.json"),
    ],
  };
}

export function museArgv(config: CoordConfig, session: MuseSession): readonly string[] {
  const phase = session.kind === "plan" ? config.plan : config.react;
  return [
    ...config.museCommand,
    "exec",
    "--json",
    "--prompt-file",
    join(session.runDir, `prompt-${String(session.k)}.md`),
    "--api-key-stdin",
    "--provider",
    "meta",
    "--model",
    config.model,
    "--contributor-mode",
    config.contributorMode,
    "--reasoning-effort",
    phase.reasoningEffort,
    "--max-model-steps",
    String(phase.maxModelSteps),
    "--max-tool-output-bytes",
    String(config.maxToolOutputBytes),
    "--no-parallel-tool-calls",
    "--session-id",
    session.sessionId,
    "--workspace",
    join(session.runDir, "workspace"),
    "--approval-mode",
    config.approvalMode,
    "--approval-judge",
    "off",
    "--disable-shell",
    "--disable-write",
    "--disable-web-tools",
    "--disable-reminders",
    "--disable-request-user-input",
    "--no-foreign-personal-context",
    "-c",
    `mcpServers.factory=${JSON.stringify(factoryEntry(session))}`,
  ];
}

export function exportArgv(config: CoordConfig, session: MuseSession): readonly string[] {
  return [
    ...config.museCommand,
    "export",
    "--session",
    session.sessionId,
    "--redacted",
    "--out",
    join(session.runDir, `session-${String(session.k)}-export.json`),
  ];
}
