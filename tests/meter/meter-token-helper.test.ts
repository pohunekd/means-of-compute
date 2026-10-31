// The host meter-token helper reads the slot from the process env.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import process from "node:process";

const HELPER = new URL("../../scripts/host/meter-token.mjs", import.meta.url);

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runHelper(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER.pathname, "MOC_METER_TOKEN"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

test("the helper prints the slot value (D4)", async () => {
  const token = `moc1.cmVxLTE.${"A".repeat(43)}`;
  const result = await runHelper({ PATH: process.env["PATH"] ?? "", MOC_METER_TOKEN: token });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(token);
});

test("the helper fails loudly when the slot is absent (D4)", async () => {
  const result = await runHelper({ PATH: process.env["PATH"] ?? "" });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("meter-token: MOC_METER_TOKEN is not set\n");
});
