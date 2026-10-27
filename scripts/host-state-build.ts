// Builds the host-state plugin package directory per target.
// Usage: bun run plugin:build --target <native|all|bun-...> --out <dir>
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { hostStateTargets, loadHostStateConfig } from "../src/hoststate/config.js";

const root = process.cwd();

function usageError(message: string): never {
  console.error(`plugin:build: ${message}`);
  process.exit(2);
}

function parseArgs(args: readonly string[]): { target: string; out: string } {
  let target: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--target" && args[i + 1] !== undefined) {
      target = args[i + 1];
      i++;
    } else if (arg === "--out" && args[i + 1] !== undefined) {
      out = args[i + 1];
      i++;
    } else {
      usageError(`unknown argument ${arg ?? "(missing value)"}`);
    }
  }
  if (target === undefined || out === undefined) {
    usageError("usage: bun run plugin:build --target <native|all|bun-...> --out <dir>");
  }
  return { target, out };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const { target, out } = parseArgs(Bun.argv.slice(2));
const outDir = isAbsolute(out) ? out : join(root, out);

// The digest script compares the computed digest with the committed one and
// exits 2 on mismatch, so a stale digest cannot be built.
{
  const proc = Bun.spawn(["bun", "run", "plugin:digest"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutText, stderrText, rc] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  process.stdout.write(stdoutText);
  process.stderr.write(stderrText);
  if (rc !== 0) {
    process.exit(2);
  }
}

const config = loadHostStateConfig(join(root, "config", "host-state.json"));
const { version, sourceDigest } = config.package;

let targets: readonly string[];
if (target === "all") {
  targets = config.package.targets;
} else if (target === "native") {
  targets = ["native"];
} else if ((hostStateTargets as readonly string[]).includes(target)) {
  targets = [target];
} else {
  usageError(`unknown target ${target}`);
  targets = [];
}

if (existsSync(outDir)) {
  if (readdirSync(outDir).length > 0) {
    usageError(`output directory ${out} is not empty`);
  }
} else {
  mkdirSync(outDir, { recursive: true });
}

const gitCommitProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
const [gitCommitOut, gitCommitErr, gitCommitRc] = await Promise.all([
  new Response(gitCommitProc.stdout).text(),
  new Response(gitCommitProc.stderr).text(),
  gitCommitProc.exited,
]);
if (gitCommitRc !== 0) {
  process.stderr.write(gitCommitErr);
  process.exit(2);
}
const gitCommit = gitCommitOut.trim();
const bunVersion = Bun.version;

for (const t of targets) {
  const dirName = t === "native" ? `moc-host-state-${version}-native` : `moc-host-state-${version}-${t}`;
  const dir = join(outDir, dirName);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "moc-host-state");
  const buildArgs =
    t === "native"
      ? ["build", "--compile", "src/probe/plugin-entry.ts", "--outfile", binPath]
      : ["build", "--compile", `--target=${t}`, "src/probe/plugin-entry.ts", "--outfile", binPath];
  const build = Bun.spawn(["bun", ...buildArgs], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [buildOut, buildErr, buildRc] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  process.stdout.write(buildOut);
  process.stderr.write(buildErr);
  if (buildRc !== 0) {
    process.exit(2);
  }
  mkdirSync(join(dir, "config", "scenarios"), { recursive: true });
  cpSync(join(root, "config", "probe.json"), join(dir, "config", "probe.json"));
  for (const f of readdirSync(join(root, "config", "scenarios"))) {
    if (f.endsWith(".json")) {
      cpSync(join(root, "config", "scenarios", f), join(dir, "config", "scenarios", f));
    }
  }
  const binarySha256 = sha256Hex(readFileSync(binPath));
  const buildTarget = t === "native" ? `native-${process.platform}-${process.arch}` : t;
  const buildJson = {
    packageId: config.package.id,
    version,
    target: buildTarget,
    gitCommit,
    sourceDigest,
    bunVersion,
    binarySha256,
  };
  writeFileSync(join(dir, "build.json"), `${JSON.stringify(buildJson, null, 2)}\n`);
}

console.log(`plugin:build: wrote ${String(targets.length)} package(s) to ${out}`);
