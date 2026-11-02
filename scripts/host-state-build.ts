// Builds the host-state plugin package directory.
// Usage: bun run plugin:build --out <dir> --target <triple>
// The authoritative guard for external file inclusion is the dep-info check
// after cargo succeeds: it reads target/<triple>/release/moc-host-state.d and
// ensures every prerequisite is a digest input or under <cargoHome>/registry/src/.
// Fast early checks for include/cfg_attr and manifest restrictions live in plugin:digest.
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadHostStateConfig } from "../src/hoststate/config.js";
import { listHostStateDigestInputs } from "./host-state-digest.ts";

const root = process.cwd();

function usageError(message: string): never {
  console.error(`plugin:build: ${message}`);
  process.exit(2);
}

function parseArgs(args: readonly string[]): { out: string; target: string } {
  let out: string | undefined;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out" && args[i + 1] !== undefined) {
      out = args[i + 1];
      i++;
    } else if (arg === "--target" && args[i + 1] !== undefined) {
      target = args[i + 1];
      i++;
    } else {
      usageError(`unknown argument ${arg ?? "(missing value)"}`);
    }
  }
  if (out === undefined || target === undefined) {
    usageError("usage: bun run plugin:build --out <dir> --target <triple>");
  }
  return { out, target };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function indexOfUnescapedColon(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ":" && (i === 0 || line[i - 1] !== "\\")) return i;
  }
  return -1;
}

function splitPrerequisites(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? "";
    const isWs = ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
    const escaped = i > 0 && input[i - 1] === "\\";
    if (isWs && !escaped) {
      if (cur.length > 0) {
        tokens.push(cur.replace(/\\ /g, " "));
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) tokens.push(cur.replace(/\\ /g, " "));
  return tokens.filter((t) => t.length > 0);
}

const { out, target } = parseArgs(Bun.argv.slice(2));
const outDir = isAbsolute(out) ? out : join(root, out);

const allowedTargets = new Set(["x86_64-unknown-linux-musl", "aarch64-apple-darwin"]);
if (!allowedTargets.has(target)) {
  usageError(`unknown target ${target}`);
}

const platformForTarget: Record<string, NodeJS.Platform> = {
  "x86_64-unknown-linux-musl": "linux",
  "aarch64-apple-darwin": "darwin",
};
if (platformForTarget[target] !== process.platform) {
  usageError(`target ${target} cannot be built on ${process.platform}`);
}

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

if (existsSync(outDir)) {
  const isDirectory = statSync(outDir, { throwIfNoEntry: false })?.isDirectory() ?? false;
  if (!isDirectory) {
    usageError(`output path ${out} is not a directory`);
  }
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

const rustcProc = Bun.spawn([process.env.RUSTC ?? "rustc", "--version"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
const [rustcOut, rustcErr, rustcRc] = await Promise.all([
  new Response(rustcProc.stdout).text(),
  new Response(rustcProc.stderr).text(),
  rustcProc.exited,
]);
if (rustcRc !== 0) {
  process.stderr.write(rustcErr);
  process.exit(2);
}
const rustcVersion = rustcOut.trim();

let cargoHome: string;
if (process.env.CARGO_HOME !== undefined) {
  cargoHome = process.env.CARGO_HOME;
} else if (process.env.HOME !== undefined) {
  cargoHome = join(process.env.HOME, ".cargo");
} else {
  usageError("CARGO_HOME or HOME must be set");
}

// Third remap for rust-src sysroot to make binary deterministic
let sysroot: string;
{
  const proc = Bun.spawn([process.env.RUSTC ?? "rustc", "--print", "sysroot"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [outText, errText, rc] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (rc !== 0) {
    process.stderr.write(errText);
    console.error("plugin:build: cannot read sysroot");
    process.exit(2);
  }
  sysroot = outText.trim();
  if (sysroot.length === 0) {
    console.error("plugin:build: cannot read sysroot");
    process.exit(2);
  }
}

let commitHash: string;
{
  const proc = Bun.spawn([process.env.RUSTC ?? "rustc", "-vV"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [outText, errText, rc] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (rc !== 0) {
    process.stderr.write(errText);
    console.error("plugin:build: cannot read commit hash");
    process.exit(2);
  }
  const match = outText.match(/^commit-hash:\s*(.+)$/m);
  if (!match || match[1] === undefined) {
    console.error("plugin:build: cannot read commit hash");
    process.exit(2);
  }
  commitHash = match[1].trim();
  if (commitHash.length === 0) {
    console.error("plugin:build: cannot read commit hash");
    process.exit(2);
  }
}

const remapFlags = [
  `--remap-path-prefix=${root}=.`,
  `--remap-path-prefix=${cargoHome}=cargo`,
  `--remap-path-prefix=${sysroot}/lib/rustlib/src/rust=/rustc/${commitHash}`,
];
const cargoEncodedRustflags = remapFlags.join("\x1f");

const restEnv: Record<string, string | undefined> = { ...process.env };
delete restEnv.RUSTFLAGS;
delete restEnv.CARGO_ENCODED_RUSTFLAGS;

const build = Bun.spawn(
  [
    "cargo",
    "build",
    "--release",
    "--locked",
    "--target",
    target,
    "--target-dir",
    join(root, "target"),
    "-p",
    "moc-host-state",
  ],
  {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...restEnv, CARGO_ENCODED_RUSTFLAGS: cargoEncodedRustflags },
  },
);
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

// Authoritative dep-info check: ensure every prerequisite is a digest input or cargo registry
{
  const builtBinary = join(root, "target", target, "release", "moc-host-state");
  const depInfoPath = `${builtBinary}.d`;
  if (!existsSync(depInfoPath)) {
    console.error(`plugin:build: ${depInfoPath}: dep-info not found`);
    process.exit(2);
  }
  const depInfoContent = readFileSync(depInfoPath, "utf-8");
  const lines = depInfoContent.split("\n");
  let targetLine: string | undefined;
  for (const rawLine of lines) {
    if (rawLine.trim().length === 0) continue;
    if (rawLine.trimStart().startsWith("#")) continue;
    const colonIdx = indexOfUnescapedColon(rawLine);
    if (colonIdx === -1) continue;
    const targetPart = rawLine.slice(0, colonIdx).trim().replace(/\\ /g, " ");
    if (targetPart === builtBinary) {
      targetLine = rawLine;
      break;
    }
  }
  if (targetLine !== undefined) {
    const colonIdx = indexOfUnescapedColon(targetLine);
    const prereqsPart = targetLine.slice(colonIdx + 1);
    const prereqs = splitPrerequisites(prereqsPart);
    const digestInputs = listHostStateDigestInputs(root);
    const allowed = new Set(digestInputs.map((rel) => join(root, rel)));
    const registryPrefix = join(cargoHome, "registry", "src") + "/";
    const offending: string[] = [];
    for (const p of prereqs) {
      if (p.length === 0) continue;
      if (allowed.has(p)) continue;
      if (p.startsWith(registryPrefix)) continue;
      offending.push(p);
    }
    if (offending.length > 0) {
      for (const f of offending) {
        console.error(`plugin:build: ${f} is not a digest input`);
      }
      process.exit(2);
    }
  }
}

const dir = join(outDir, `moc-host-state-${version}-${target}`);
const binDir = join(dir, "bin");
mkdirSync(binDir, { recursive: true });
const builtBinary = join(root, "target", target, "release", "moc-host-state");
const binPath = join(binDir, "moc-host-state");
cpSync(builtBinary, binPath);
chmodSync(binPath, 0o755);
mkdirSync(join(dir, "config", "scenarios"), { recursive: true });
cpSync(join(root, "config", "plugin.json"), join(dir, "config", "plugin.json"));
cpSync(join(root, "config", "probe.json"), join(dir, "config", "probe.json"));
for (const f of readdirSync(join(root, "config", "scenarios"))) {
  if (f.endsWith(".json")) {
    cpSync(join(root, "config", "scenarios", f), join(dir, "config", "scenarios", f));
  }
}
const binarySha256 = sha256Hex(readFileSync(binPath));
const buildJson = {
  packageId: config.package.id,
  version,
  command: config.package.command,
  gitCommit,
  sourceDigest,
  rustcVersion,
  cargoTarget: target,
  binarySha256,
};
writeFileSync(join(dir, "build.json"), `${JSON.stringify(buildJson, null, 2)}\n`);

const runtimeToml = [
  "schema = 1",
  `id = "${config.package.id}"`,
  `version = "${version}"`,
  "runtime_api = 1",
  `requires = ["package-commands-v1"]`,
  "",
  `[commands.${config.package.command}]`,
  `program = "bin/moc-host-state"`,
  `args = []`,
  `expose = "peers"`,
  "",
].join("\n");
writeFileSync(join(dir, "runtime.toml"), runtimeToml);

console.log(`plugin:build: wrote 1 package(s) to ${out}`);
