// Stub worker: one metered model call and a scripted patch per new memory
// session. The worker handles each starting or running session once; the
// scheduler calls step() after each tick.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryPortControl } from "../../dispatcher/memory-port.js";
import { type SandboxGit, SandboxError, sandboxGit } from "./sandbox.js";

export interface StubWorkerDeps {
  readonly control: MemoryPortControl;
  readonly meter: { readonly port: number; tokenFor(requestId: string): string };
  readonly sessionModelId: string;
  readonly originDir: string;
  readonly hostsDir: string;
  readonly git: SandboxGit;
  readonly patchFor: (workItemId: string, round: number) => string | null;
}

export interface StubWorker {
  step(): Promise<readonly string[]>;
}

function workItemIdOf(requestId: string): string {
  return requestId.slice(0, requestId.lastIndexOf(":"));
}

// One streamed chat call through the real meter; a non-200 status fails
// the session. The body is drained so the meter records the usage.
async function meteredCall(deps: StubWorkerDeps, requestId: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${String(deps.meter.port)}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deps.meter.tokenFor(requestId)}`,
    },
    body: JSON.stringify({
      model: deps.sessionModelId,
      messages: [{ role: "user", content: `Work item ${workItemIdOf(requestId)}, round 0.` }],
      stream: true,
    }),
  });
  await response.text();
  return response.status;
}

// Clone once per host, check out the item branch, apply the scripted
// patch and push it to the sandbox origin.
async function applyPatch(
  deps: StubWorkerDeps,
  hostAlias: string,
  branch: string,
  workItemId: string,
  round: number,
  patchPath: string,
): Promise<void> {
  const cloneDir = join(deps.hostsDir, hostAlias);
  if (!existsSync(join(cloneDir, ".git"))) {
    await sandboxGit(deps.git, deps.hostsDir, ["clone", deps.originDir, cloneDir]);
  }
  await sandboxGit(deps.git, cloneDir, ["fetch", "origin"]);
  const listed = await sandboxGit(deps.git, cloneDir, ["ls-remote", deps.originDir, branch]);
  const base = listed.trim().length > 0 ? `origin/${branch}` : "origin/main";
  await sandboxGit(deps.git, cloneDir, ["checkout", "-B", branch, base]);
  await sandboxGit(deps.git, cloneDir, ["apply", "--index", patchPath]);
  await sandboxGit(deps.git, cloneDir, ["commit", "-m", `Round ${String(round)} for ${workItemId}`]);
  await sandboxGit(deps.git, cloneDir, ["push", "origin", `HEAD:refs/heads/${branch}`]);
}

export function createStubWorker(deps: StubWorkerDeps): StubWorker {
  const handled = new Map<string, number>();
  async function step(): Promise<readonly string[]> {
    const done: string[] = [];
    const sessions = deps.control.sessions();
    for (const session of sessions) {
      if (session.state !== "starting" && session.state !== "running") {
        continue;
      }
      if (handled.has(session.handle.sessionId)) {
        continue;
      }
      const requestId = session.handle.requestId;
      const workItemId = workItemIdOf(requestId);
      const handledRounds = [...handled.entries()].filter(([id]) => {
        const other = sessions.find((candidate) => candidate.handle.sessionId === id);
        return other !== undefined && workItemIdOf(other.handle.requestId) === workItemId;
      }).length;
      const patchPath = deps.patchFor(workItemId, handledRounds);
      handled.set(session.handle.sessionId, handledRounds);
      if (patchPath === null) {
        deps.control.complete(session.handle.sessionId, {
          state: "failed",
          usage: null,
          detail: "no scripted round",
        });
        done.push(session.handle.sessionId);
        continue;
      }
      const status = await meteredCall(deps, requestId);
      if (status !== 200) {
        deps.control.complete(session.handle.sessionId, {
          state: "failed",
          usage: null,
          detail: `meter call ${String(status)}`,
        });
        done.push(session.handle.sessionId);
        continue;
      }
      try {
        await applyPatch(
          deps,
          session.handle.hostAlias,
          session.handle.branch,
          workItemId,
          handledRounds,
          patchPath,
        );
      } catch (error: unknown) {
        if (error instanceof SandboxError) {
          throw error;
        }
        throw error;
      }
      deps.control.complete(session.handle.sessionId, {
        state: "finished",
        usage: null,
        detail: "exited 0",
      });
      done.push(session.handle.sessionId);
    }
    return done;
  }
  return { step };
}
