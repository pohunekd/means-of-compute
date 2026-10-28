// CLI tests (D1, D2, M4, M5): the CLI runs as a child process whose cwd
// is a temp directory with its own config/ tree, so the committed config
// is never touched and no real network or model is involved. Config:
// ledger.json points into the temp dir, auditor.json holds a temp
// verdictDir, budget-gate.json holds a stub that prints what the real
// check prints for admit. Mutations: run the same recording for both
// branches; drop the SHA binding between marker and verdict file;
// append only on success (M5: no new ledger line on re-post);
// plain Error for post failures (M4: rc 2 instead of 4).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLoopback } from "../../src/providers/loopback.js";
import { demoItem, makeTempRepo, removeTempRepo, type TempRepo } from "./temp-repo.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "src", "auditor", "cli.ts");

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliTree {
  readonly dir: string;
  readonly cleanup: () => void;
}

// A temp cwd with its own config tree: no test edits a tracked file.
async function makeCliTree(): Promise<CliTree> {
  const dir = mkdtempSync(join(tmpdir(), "auditor-cli-"));
  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await mkdir(join(dir, "config", "providers"), { recursive: true });
    await mkdir(join(dir, "verdicts"), { recursive: true });
    for (const name of [
      "meta-api.json",
      "nvidia-build.json",
      "meta-wonder.json",
      "route.json",
      "schema.json",
    ]) {
      const source = await Bun.file(join(REPO_ROOT, "config", "providers", name)).text();
      await Bun.write(join(dir, "config", "providers", name), source);
    }
    await Bun.write(
      join(dir, "config", "auditor.json"),
      JSON.stringify({
        auditors: [
          { providerId: "meta-api", model: "muse-spark-1.3-contributor" },
          { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" },
        ],
        mergeAuditor: { providerId: "meta-wonder", model: "muse-wonder-1.0" },
        verdictDir: join(dir, "verdicts"),
        maxDiffBytes: 200000,
        maxFindings: 50,
        maxFieldChars: 2000,
      }),
    );
    await Bun.write(
      join(dir, "config", "ledger.json"),
      JSON.stringify({ ledgerPath: join(dir, "ledger.jsonl") }),
    );
    await Bun.write(join(dir, "ledger.jsonl"), "");
    // The stub prints what the real check prints for admit (rc 0).
    await Bun.write(
      join(dir, "stub-gate.ts"),
      `console.log("admitted: test admit (today $0.00, total $0.00, nvidia requests today 0)");\n`,
    );
    await Bun.write(
      join(dir, "config", "budget-gate.json"),
      JSON.stringify({ command: ["bun", join(dir, "stub-gate.ts")], timeoutMs: 30000 }),
    );
    return { dir, cleanup };
  } catch (error: unknown) {
    cleanup();
    throw error;
  }
}

async function writeItem(tree: CliTree, branch: "demo-good" | "demo-bad"): Promise<string> {
  const itemPath = join(tree.dir, "item.json");
  await Bun.write(itemPath, `${JSON.stringify(demoItem(branch))}\n`);
  return itemPath;
}

function cliEnv(port: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env["NVIDIA_API_KEY"] = "test";
  env["META_API_KEY"] = "test";
  env["LOCAL_MODEL_BASE_URL"] = "http://localhost:1148/v1";
  // Pin every descriptor base URL to the loopback stub, so a regression
  // in a child can never reach a third-party endpoint.
  env["PROVIDER_META_API_BASE_URL"] = `http://127.0.0.1:${String(port)}`;
  env["PROVIDER_NVIDIA_BUILD_BASE_URL"] = `http://127.0.0.1:${String(port)}`;
  env["PROVIDER_META_WONDER_BASE_URL"] = `http://127.0.0.1:${String(port)}`;
  return env;
}

async function runCliWithLoopback(
  tree: CliTree,
  repo: TempRepo,
  ref: string,
  recording: string,
  extra: string[],
): Promise<CliRun & { readonly port: number }> {
  const server = await startLoopback(recording);
  try {
    const itemPath = join(tree.dir, "item.json");
    const proc = Bun.spawn(
      [
        "bun",
        CLI,
        "--repo-dir",
        repo.dir,
        "--ref",
        ref,
        "--base",
        "main",
        "--item",
        itemPath,
        "--authors",
        "flags",
        "--author-model",
        "meta/muse-glimmer-30b",
        ...extra,
      ],
      { cwd: tree.dir, stdout: "pipe", stderr: "pipe", env: cliEnv(server.port) },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, port: server.port };
  } finally {
    void server.stop();
  }
}

// A fake gh on PATH: `pr comment` stores the body, counts the call and
// fails or succeeds per $GH_STATE/mode; `api` prints the first line of
// the stored body, or two pages' worth when $GH_STATE/two-pages exists.
async function installFakeGh(tree: CliTree, mode: "fail" | "ok"): Promise<void> {
  const bin = join(tree.dir, "bin");
  const state = join(tree.dir, "gh-state");
  await mkdir(bin, { recursive: true });
  await mkdir(state, { recursive: true });
  await Bun.write(join(state, "mode"), mode);
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh\n` +
      `state="${state}"\n` +
      `if [ "$1" = "pr" ]; then\n` +
      `  echo x >> "$state/calls"\n` +
      `  body=""; prev="";\n` +
      `  for arg in "$@"; do if [ "$prev" = "--body-file" ]; then body="$arg"; fi; prev="$arg"; done\n` +
      `  cp "$body" "$state/comment.md"\n` +
      `  if [ "$(cat "$state/mode")" = "fail" ]; then echo "fake gh: pr comment failed" >&2; exit 1; fi\n` +
      `  exit 0\n` +
      `fi\n` +
      // The fake pins the verify contract: an api call without
      // --paginate --jq and the exact first-lines program exits 1.
      `if [ "$1" = "api" ]; then\n` +
      `  want='.[] | .body | split("\n")[0]';\n` +
      `  got_paginate=""; got_jq=""; prev="";\n` +
      `  for arg in "$@"; do\n` +
      `    if [ "$arg" = "--paginate" ]; then got_paginate=1; fi;\n` +
      `    if [ "$prev" = "--jq" ]; then got_jq="$arg"; fi;\n` +
      `    prev="$arg";\n` +
      `  done;\n` +
      `  if [ "$got_paginate" != 1 ] || [ "$got_jq" != "$want" ]; then echo "fake gh: api needs --paginate --jq <program>" >&2; exit 1; fi\n` +
      `fi\n` +
      `body=$(cat "$state/comment.md" 2>/dev/null || echo "")\n` +
      `first=$(printf '%s' "$body" | head -n 1)\n` +
      `if [ -f "$state/two-pages" ]; then printf 'unrelated first line\n%s\n' "$first"; else printf '%s\n' "$first"; fi\n`,
  );
  await Bun.$`chmod +x ${join(bin, "gh")}`;
}

async function ghCommentCalls(tree: CliTree): Promise<number> {
  const text = await Bun.file(join(tree.dir, "gh-state", "calls"))
    .text()
    .catch(() => "");
  return text.split("\n").filter((line) => line === "x").length;
}

function ghEnv(port: number, tree: CliTree): Record<string, string> {
  const env = cliEnv(port);
  env["PATH"] = `${join(tree.dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;
  return env;
}

async function runCliWithGh(
  tree: CliTree,
  repo: TempRepo,
  ref: string,
  recording: string,
  extra: string[],
): Promise<CliRun> {
  const server = await startLoopback(recording);
  try {
    const itemPath = join(tree.dir, "item.json");
    const proc = Bun.spawn(
      [
        "bun",
        CLI,
        "--repo-dir",
        repo.dir,
        "--ref",
        ref,
        "--base",
        "main",
        "--item",
        itemPath,
        "--authors",
        "flags",
        "--author-model",
        "meta/muse-glimmer-30b",
        ...extra,
      ],
      { cwd: tree.dir, stdout: "pipe", stderr: "pipe", env: ghEnv(server.port, tree) },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    void server.stop();
  }
}

test("D1: clean branch gets a clean verdict bound to the head SHA (mutation: bind the marker to the ref name)", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    const run = await runCliWithLoopback(
      tree,
      repo,
      "demo-good",
      "tests/auditor/recordings/clean.json",
      ["--pull", "99"],
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(lines[1]).toContain("high=0:medium=0");
    const head = (await Bun.$`git -C ${repo.dir} rev-parse demo-good`.text()).trim();
    expect(lines[1]).toContain(head);
    expect(run.stdout).toContain("No findings.");
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("D2: defect branch gets a high finding with path:line evidence", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-bad");
    const run = await runCliWithLoopback(
      tree,
      repo,
      "demo-bad",
      "tests/auditor/recordings/defect.json",
      ["--pull", "99"],
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(lines[1]).toContain("high=1:medium=0");
    const head = (await Bun.$`git -C ${repo.dir} rev-parse demo-bad`.text()).trim();
    expect(lines[1]).toContain(head);
    expect(run.stdout).toMatch(/src\/add\.ts:\d+/);
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("M4: a failing gh post exits 4 with a single audit: prefix", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    await installFakeGh(tree, "fail");
    const run = await runCliWithGh(tree, repo, "demo-good", "tests/auditor/recordings/clean.json", [
      "--pull",
      "99",
      "--post",
      "yes",
    ]);
    expect(run.code).toBe(4);
    expect(run.stderr).toContain("audit: gh pr comment failed");
    expect(run.stderr).not.toContain("audit: audit:");
    // Exactly one prefix: the CLI catch adds it, the layers below do not.
    expect(run.stderr.split("audit:")).toHaveLength(2);
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("M5: --post re-posts a stored verdict with no model call and no new ledger line", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    const head = (await Bun.$`git -C ${repo.dir} rev-parse demo-good`.text()).trim();
    await installFakeGh(tree, "fail");
    const first = await runCliWithGh(
      tree,
      repo,
      "demo-good",
      "tests/auditor/recordings/clean.json",
      ["--pull", "99", "--post", "yes"],
    );
    expect(first.code).toBe(4);
    const stored = JSON.parse(
      await readFile(join(tree.dir, "verdicts", "w9-demo", `${head}.json`), "utf8"),
    ) as unknown;
    expect(stored).toMatchObject({ headSha: head });
    const ledgerBefore = await Bun.file(join(tree.dir, "ledger.jsonl")).text();

    // A counting loopback in front of the clean recording: the re-post
    // must make zero requests.
    let requests = 0;
    const recording = JSON.parse(
      await Bun.file(join(REPO_ROOT, "tests", "auditor", "recordings", "clean.json")).text(),
    ) as unknown;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        return Response.json(recording);
      },
    });
    const port = server.port;
    if (port === undefined) {
      throw new Error("counting loopback has no port");
    }
    await installFakeGh(tree, "ok");
    const itemPath = join(tree.dir, "item.json");
    const proc = Bun.spawn(
      [
        "bun",
        CLI,
        "--repo-dir",
        repo.dir,
        "--ref",
        "demo-good",
        "--base",
        "main",
        "--item",
        itemPath,
        "--authors",
        "flags",
        "--author-model",
        "meta/muse-glimmer-30b",
        "--pull",
        "99",
        "--post",
        "yes",
      ],
      { cwd: tree.dir, stdout: "pipe", stderr: "pipe", env: ghEnv(port, tree) },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    void server.stop();
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`posted stored verdict ${head}`);
    expect(requests).toBe(0);
    expect(await Bun.file(join(tree.dir, "ledger.jsonl")).text()).toBe(ledgerBefore);
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("M-2: re-post to another PR exits 2 and makes no gh pr comment call", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    const head = (await Bun.$`git -C ${repo.dir} rev-parse demo-good`.text()).trim();
    await installFakeGh(tree, "ok");
    const first = await runCliWithGh(
      tree,
      repo,
      "demo-good",
      "tests/auditor/recordings/clean.json",
      ["--pull", "99"],
    );
    expect(first.code).toBe(0);
    const second = await runCliWithGh(
      tree,
      repo,
      "demo-good",
      "tests/auditor/recordings/clean.json",
      ["--pull", "100", "--post", "yes"],
    );
    expect(second.code).toBe(2);
    expect(second.stderr.trim()).toBe(`audit: stored verdict ${head} is for #99, not #100`);
    expect(await ghCommentCalls(tree)).toBe(0);
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("L-4: a null-PR stored verdict re-posts with the --pull marker", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    const head = (await Bun.$`git -C ${repo.dir} rev-parse demo-good`.text()).trim();
    await installFakeGh(tree, "ok");
    const first = await runCliWithGh(
      tree,
      repo,
      "demo-good",
      "tests/auditor/recordings/clean.json",
      [],
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("no pull request: verdict stored without a marker");
    const second = await runCliWithGh(
      tree,
      repo,
      "demo-good",
      "tests/auditor/recordings/clean.json",
      ["--pull", "99", "--post", "yes"],
    );
    expect(second.stderr).toBe("");
    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe(`posted stored verdict ${head}`);
    const posted = await Bun.file(join(tree.dir, "gh-state", "comment.md")).text();
    expect(posted.split("\n")[0]).toContain(`#99@${head}`);
    // The stored file keeps its null PR: the marker is rendered, not stored.
    const stored = JSON.parse(
      await readFile(join(tree.dir, "verdicts", "w9-demo", `${head}.json`), "utf8"),
    ) as { pullNumber: number | null };
    expect(stored.pullNumber).toBeNull();
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("C-1: a marker on the second page verifies with rc 0 (mutation: read only the first line)", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    const head = (await Bun.$`git -C ${repo.dir} rev-parse demo-good`.text()).trim();
    await installFakeGh(tree, "ok");
    await Bun.write(join(tree.dir, "gh-state", "two-pages"), "");
    const first = await runCliWithGh(
      tree,
      repo,
      "demo-good",
      "tests/auditor/recordings/clean.json",
      ["--pull", "99"],
    );
    expect(first.code).toBe(0);
    const run = await runCliWithGh(tree, repo, "demo-good", "tests/auditor/recordings/clean.json", [
      "--pull",
      "99",
      "--post",
      "yes",
    ]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(`posted stored verdict ${head}`);
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("L-2: an invalid item exits 2 with a single audit: prefix", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    // An item with an empty DoD fails isWorkItem in the library as in
    // the CLI: the catch adds the only prefix.
    const item = { ...demoItem("demo-good"), dod: [] };
    await Bun.write(join(tree.dir, "item.json"), `${JSON.stringify(item)}\n`);
    await installFakeGh(tree, "ok");
    const run = await runCliWithGh(tree, repo, "demo-good", "tests/auditor/recordings/clean.json", [
      "--pull",
      "99",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("audit: Work item");
    expect(run.stderr.split("audit:")).toHaveLength(2);
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("L-5: a positional argument exits 2 with audit: unknown argument", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    await installFakeGh(tree, "ok");
    const run = await runCliWithGh(tree, repo, "demo-good", "tests/auditor/recordings/clean.json", [
      "--pull",
      "99",
      "extra-positional",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("audit: unknown argument extra-positional");
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("L-5: a single-dash typo exits 2 with audit: unknown argument", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    await installFakeGh(tree, "ok");
    const run = await runCliWithGh(tree, repo, "demo-good", "tests/auditor/recordings/clean.json", [
      "-pull",
      "99",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("audit: unknown argument -pull");
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("L1: --phase-critical requires --pull (mutation: drop the CLI check)", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    const server = await startLoopback("tests/auditor/recordings/wonder-clean.json");
    let run: CliRun;
    try {
      const itemPath = join(tree.dir, "item.json");
      const proc = Bun.spawn(
        [
          "bun",
          CLI,
          "--repo-dir",
          repo.dir,
          "--ref",
          "demo-good",
          "--base",
          "main",
          "--item",
          itemPath,
          "--authors",
          "flags",
          "--author-model",
          "meta/muse-glimmer-30b",
          "--phase-critical",
          "yes",
        ],
        { cwd: tree.dir, stdout: "pipe", stderr: "pipe", env: cliEnv(server.port) },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      run = { code, stdout, stderr };
    } finally {
      void server.stop();
    }
    expect(run.code).toBe(2);
    expect(run.stderr.trim()).toBe("audit: --phase-critical requires --pull");
    // The flag check runs before any model call, so server.requests() has length 0.
    expect(run.stdout).toBe("");
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});

test("L2: phase-critical re-post refuses a general verdict (mutation: drop the P10 check)", async () => {
  const repo = await makeTempRepo();
  const tree = await makeCliTree();
  try {
    await writeItem(tree, "demo-good");
    const head = (await Bun.$`git -C ${repo.dir} rev-parse demo-good`.text()).trim();
    await installFakeGh(tree, "ok");
    // A first run stores a Spark verdict (Glimmer authored, no opt-in).
    const first = await runCliWithGh(
      tree,
      repo,
      "demo-good",
      "tests/auditor/recordings/clean.json",
      ["--pull", "7"],
    );
    expect(first.code).toBe(0);
    const callsBefore = await ghCommentCalls(tree);
    const ledgerBefore = await Bun.file(join(tree.dir, "ledger.jsonl")).text();
    // The re-post with the opt-in refuses the stored Spark verdict:
    // no new loopback request (length before equals length after).
    const second = await runCliWithGh(
      tree,
      repo,
      "demo-good",
      "tests/auditor/recordings/clean.json",
      ["--pull", "7", "--post", "yes", "--phase-critical", "yes"],
    );
    expect(second.code).toBe(3);
    expect(second.stderr.trim()).toBe(
      `audit: refused: stored verdict ${head} is by muse-spark-1.3-contributor, not the merge auditor muse-wonder-1.0`,
    );
    expect(await ghCommentCalls(tree)).toBe(callsBefore);
    expect(await Bun.file(join(tree.dir, "ledger.jsonl")).text()).toBe(ledgerBefore);
  } finally {
    tree.cleanup();
    removeTempRepo(repo.dir);
  }
});
