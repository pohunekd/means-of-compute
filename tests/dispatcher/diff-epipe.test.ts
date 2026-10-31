// dispatch:diff into a reader that closes early: the child runs the real
// runDiffCommand over a stub port with the cli.ts io and the EPIPE guard,
// and its stdout goes through a real pipe into `head -c 100`.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIFF_COMMAND = join(import.meta.dir, "../../src/dispatcher/diff-command.ts");

const CHILD = `
import { ignoreReaderClosed, runDiffCommand } from ${JSON.stringify(DIFF_COMMAND)};
ignoreReaderClosed(process.stdout);
const port = {
  diff: async () => ({ unifiedDiff: "x".repeat(8388609), truncated: false }),
  close: async () => {},
};
process.exitCode = await runDiffCommand(
  ["--host", "laptop-a", "--session", "s-1", "--base", "origin/main"],
  async () => port,
  {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (line) => { console.error(line); },
  },
);
`;

test("a reader that closes early leaves rc 0 and an empty stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moc-diff-epipe-"));
  try {
    const script = join(dir, "child.ts");
    const errPath = join(dir, "stderr.txt");
    await writeFile(script, CHILD);
    const proc = Bun.spawn(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        'bun run "$1" 2>"$2" | head -c 100 >/dev/null',
        "sh",
        script,
        errPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const rc = await proc.exited;
    expect(await readFile(errPath, "utf8")).toBe("");
    expect(rc).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
