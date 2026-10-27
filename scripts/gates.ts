// Runs every gate as its own process and reports each exit code. Output is printed only
// for failing gates, so agents spend no context on passing ones.
interface Gate {
  readonly name: string;
  readonly cmd: readonly string[];
}

const gates: readonly Gate[] = [
  { name: "format", cmd: ["bunx", "prettier", "--check", "--log-level", "warn", "."] },
  { name: "lint", cmd: ["bunx", "eslint", "--max-warnings", "0", "."] },
  { name: "typecheck", cmd: ["bunx", "tsc", "--noEmit"] },
  { name: "contracts", cmd: ["bun", "run", "contracts:check"] },
  { name: "providers", cmd: ["bun", "run", "providers:check"] },
  {
    name: "test",
    cmd: [
      "bun",
      "test",
      "--only-failures",
      "--pass-with-no-tests",
      "--path-ignore-patterns=quarantine/**",
    ],
  },
];

async function runGate(gate: Gate): Promise<number> {
  const proc = Bun.spawn([...gate.cmd], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, rc] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  console.log(`gate ${gate.name} rc=${String(rc)}`);
  if (rc !== 0) {
    console.log(`${stdout}${stderr}`.trimEnd());
  }
  return rc;
}

let failed = 0;
for (const gate of gates) {
  if ((await runGate(gate)) !== 0) {
    failed += 1;
  }
}
process.exit(failed === 0 ? 0 : 1);
