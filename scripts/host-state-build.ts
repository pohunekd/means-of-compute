// Builds the host-state plugin package directory.
// Usage: bun run plugin:build --out <dir> --target <triple>
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

const rustcProc = Bun.spawn(["rustc", "--version"], {
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

const cargoHome =
  process.env.CARGO_HOME ??
  (process.env.HOME !== undefined ? join(process.env.HOME, ".cargo") : join(root, ".cargo"));

const rflags = `--remap-path-prefix=${root}=. --remap-path-prefix=${cargoHome}=cargo`;

const build = Bun.spawn(
  ["cargo", "build", "--release", "--locked", "--target", target, "-p", "moc-host-state"],
  {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RUSTFLAGS: rflags },
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
