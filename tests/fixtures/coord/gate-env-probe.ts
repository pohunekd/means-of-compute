#!/usr/bin/env bun
// Gate command fixture for M16: records only whether META_API_KEY is set in
// the spawned gate child's environment, never the value. Admits every run.
const out = process.argv[2] as string;
if (typeof out !== "string" || out === "") {
  process.stderr.write("gate-env-probe: missing output path\n");
  process.exit(2);
}
const state = process.env["META_API_KEY"] === undefined ? "unset" : "set";
await Bun.write(out, `${state}\n`);
process.stdout.write("admitted: within budget (today $0.00, total $0.00)\n");
process.exit(0);
