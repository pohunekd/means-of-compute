// Gh port tests (PR 3 matrix rows L20-L21e): the fake gh drives argv
// shape, env isolation, body-file handling and every failure kind.
import { describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, createGhPort, type GhEnv } from "../../src/loop/github.js";
import type { LoopGithubConfig } from "../../src/loop/config.js";

interface Reply {
  readonly match: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly rc: number;
  readonly hang: boolean;
}

interface CallRecord {
  readonly argv: readonly string[];
  readonly envKeys: readonly string[];
  readonly tokenMatches: boolean;
  readonly bodyFile: string | null;
}

const DENYLIST = ["HOME", "USER", "GITHUB_TOKEN", "GH_HOST"];
const FORBIDDEN_PREFIX = "MOC_";

function baseConfig(dir: string, timeoutMs: number, factoryLogin: string | null): LoopGithubConfig {
  return {
    tokenEnv: "MOC_GITHUB_TOKEN",
    configDir: dir,
    factoryLogin,
    timeoutMs,
    ciPollMs: 1000,
    ciTimeoutMs: 1000,
    mergeRetries: 1,
    trustedAssociations: [],
    requiredChecks: [],
    mergeMethod: "merge",
    intake: {
      enabled: false,
      optInLabel: "opt",
      readyLabel: "ready",
      blockedLabel: "blocked",
      pollMs: 1000,
      defaultModel: "model",
      maxGoalChars: 100,
    },
    followupLabels: [],
    escalationLabel: "esc",
  };
}

async function withPort(
  replies: readonly Reply[],
  timeoutMs: number,
  factoryLogin: string | null,
  body: (port: ReturnType<typeof createGhPort>, dir: string, env: GhEnv) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "gh-port-"));
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await copyFile("tests/fixtures/loop/fake-gh.ts", join(bin, "gh"));
  await chmod(join(bin, "gh"), 0o755);
  await writeFile(
    join(dir, "fake-gh.json"),
    JSON.stringify({ token: "secret-token", replies }),
    "utf8",
  );
  const procDir = process.execPath.includes("/")
    ? process.execPath.slice(0, process.execPath.lastIndexOf("/"))
    : "";
  const env: GhEnv = { PATH: `${bin}:${procDir}`, token: "secret-token" };
  const port = createGhPort(baseConfig(dir, timeoutMs, factoryLogin), env);
  try {
    await body(port, dir, env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readCalls(dir: string): Promise<CallRecord[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "fake-gh-calls.jsonl"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CallRecord);
}

function checkCalls(calls: readonly CallRecord[]): void {
  for (const call of calls) {
    expect([...call.envKeys]).toEqual([
      "GH_CONFIG_DIR",
      "GH_PROMPT_DISABLED",
      "GH_TOKEN",
      "NO_COLOR",
      "PATH",
    ]);
    for (const denied of DENYLIST) {
      expect(call.envKeys).not.toContain(denied);
    }
    for (const key of call.envKeys) {
      expect(key.startsWith(FORBIDDEN_PREFIX)).toBe(false);
    }
    expect(call.tokenMatches).toBe(true);
    for (const arg of call.argv) {
      expect(arg.includes("secret-token")).toBe(false);
    }
  }
}

describe("gh port", () => {
  test("L20: checkRuns argv matches E3 exactly and viewPull requests five fields", async () => {
    const sha = "a".repeat(40);
    await withPort(
      [
        {
          match: ["api", `repos/o/r/commits/${sha}/check-runs`],
          stdout: '{"id":1,"name":"unit","status":"completed","conclusion":"success"}\n',
          stderr: "",
          rc: 0,
          hang: false,
        },
        {
          match: ["pr", "view"],
          stdout: JSON.stringify({
            state: "OPEN",
            headRefOid: sha,
            baseRefName: "main",
            isDraft: false,
            mergeCommit: null,
          }),
          stderr: "",
          rc: 0,
          hang: false,
        },
      ],
      5000,
      "factory",
      async (port, dir) => {
        process.env["MOC_GITHUB_TOKEN"] = "leak-check";
        const homeBefore = process.env["HOME"];
        process.env["HOME"] = "/tmp/should-not-leak";
        try {
          const runs = await port.checkRuns("o/r", sha);
          expect(runs).toHaveLength(1);
          const view = await port.viewPull("o/r", 7);
          expect(view.state).toBe("OPEN");
          const calls = await readCalls(dir);
          expect(calls).toHaveLength(2);
          expect(calls[0]?.argv).toEqual([
            "api",
            `repos/o/r/commits/${sha}/check-runs`,
            "--paginate",
            "--jq",
            ".check_runs[] | {id, name, status, conclusion}",
          ]);
          expect(calls[1]?.argv).toEqual([
            "pr",
            "view",
            "7",
            "-R",
            "o/r",
            "--json",
            "state,headRefOid,baseRefName,isDraft,mergeCommit",
          ]);
          checkCalls(calls);
        } finally {
          process.env["MOC_GITHUB_TOKEN"] = "leak-check";
          if (homeBefore === undefined) {
            delete process.env["HOME"];
          } else {
            process.env["HOME"] = homeBefore;
          }
          delete process.env["MOC_GITHUB_TOKEN"];
        }
      },
    );
  });

  test("L21b: createIssue passes labels in order and cleans the body file", async () => {
    await withPort(
      [
        {
          match: ["issue", "create"],
          stdout: "https://github.com/o/r/issues/42\n",
          stderr: "",
          rc: 0,
          hang: false,
        },
      ],
      5000,
      "factory",
      async (port, dir) => {
        const number = await port.createIssue("o/r", "title", "body text", ["a", "b"]);
        expect(number).toBe(42);
        const calls = await readCalls(dir);
        expect(calls).toHaveLength(1);
        const argv = calls[0]?.argv as readonly string[];
        expect(argv.slice(-4)).toEqual(["--label", "a", "--label", "b"]);
        expect(calls[0]?.bodyFile).toBe("body text");
        const tmp = await readdir(join(dir, "tmp"));
        expect(tmp).toHaveLength(0);
        checkCalls(calls);
      },
    );
  });

  test("L21: invalid checkRuns output is invalid-output and hang gives unavailable", async () => {
    const sha = "b".repeat(40);
    await withPort(
      [
        {
          match: ["api", `repos/o/r/commits/${sha}/check-runs`],
          stdout: "not json\n",
          stderr: "",
          rc: 0,
          hang: false,
        },
        { match: ["api"], stdout: "", stderr: "", rc: 0, hang: true },
      ],
      300,
      "factory",
      async (port, dir) => {
        const bad = await port.checkRuns("o/r", sha).catch((error: unknown) => error);
        expect(bad).toBeInstanceOf(GitHubError);
        expect((bad as GitHubError).kind).toBe("invalid-output");
        const started = Date.now();
        const hung = await port.baseSha("o/r", "main").catch((error: unknown) => error);
        expect(hung).toBeInstanceOf(GitHubError);
        expect((hung as GitHubError).kind).toBe("unavailable");
        expect(Date.now() - started).toBeLessThan(5000);
        const calls = await readCalls(dir);
        expect(calls).toHaveLength(2);
        checkCalls(calls);
      },
    );
  });

  test("L21c: factoryIssues drops pull-request rows", async () => {
    const body = JSON.stringify({ number: 5, pull_request: null, first: "goal line" });
    const prBody = JSON.stringify({ number: 6, pull_request: { url: "x" }, first: "goal line" });
    await withPort(
      [
        {
          match: ["api", "-X", "GET"],
          stdout: `${body}\n${prBody}\n`,
          stderr: "",
          rc: 0,
          hang: false,
        },
      ],
      5000,
      "factory",
      async (port, dir) => {
        const rows = await port.factoryIssues("o/r", "goal");
        expect(rows).toEqual([{ number: 5, first: "goal line" }]);
        const calls = await readCalls(dir);
        expect(calls).toHaveLength(1);
        checkCalls(calls);
      },
    );
  });

  test("L21d: postComment without a factory re-read is unverified", async () => {
    const comment = JSON.stringify({ login: "someone", first: "marker line" });
    await withPort(
      [
        { match: ["api", "-X", "POST"], stdout: "123\n", stderr: "", rc: 0, hang: false },
        {
          match: ["api", "repos/o/r/issues/7/comments"],
          stdout: `${comment}\n`,
          stderr: "",
          rc: 0,
          hang: false,
        },
      ],
      5000,
      "factory",
      async (port, dir) => {
        const failed = await port
          .postComment("o/r", 7, "marker line")
          .catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(GitHubError);
        expect((failed as GitHubError).kind).toBe("unverified");
        const calls = await readCalls(dir);
        expect(calls).toHaveLength(2);
        expect(calls[0]?.bodyFile).toBe("marker line");
        const tmp = await readdir(join(dir, "tmp"));
        expect(tmp).toHaveLength(0);
        checkCalls(calls);
      },
    );
  });

  test("L21e: mergePull pins the head and rejects with the stderr prefix", async () => {
    const sha = "c".repeat(40);
    await withPort(
      [{ match: ["pr", "merge"], stdout: "", stderr: "head moved behind\n", rc: 1, hang: false }],
      5000,
      "factory",
      async (port, dir) => {
        const failed = await port.mergePull("o/r", 7, sha).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(GitHubError);
        expect((failed as GitHubError).kind).toBe("rejected");
        expect((failed as GitHubError).detail).toBe("head moved behind\n");
        const calls = await readCalls(dir);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.argv).toEqual([
          "pr",
          "merge",
          "7",
          "-R",
          "o/r",
          "--merge",
          "--match-head-commit",
          sha,
        ]);
        checkCalls(calls);
      },
    );
  });
});
