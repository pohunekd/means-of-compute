import { test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { checkRoot } from "../scripts/docs-links";

function makeTmp() {
  const tmp = mkdtempSync(join(tmpdir(), "moc-docs-links-"));
  return tmp;
}

function cleanup(tmp: string) {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

test("docs links good case exits 0", () => {
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, "README.md"), "[good](docs/good.md)\n");
    mkdirSync(join(tmp, "docs"));
    writeFileSync(join(tmp, "docs", "good.md"), "# good\n");
    const broken = checkRoot(tmp);
    if (broken.length !== 0) {
      throw new Error(`Expected no broken links, got ${JSON.stringify(broken)}`);
    }
  } finally {
    cleanup(tmp);
  }

  const resMissing = Bun.spawnSync(["bun", "run", "scripts/docs-links.ts", "--root"], {});
  if (resMissing.exitCode !== 2)
    throw new Error(`Expected exit 2 for missing --root value, got ${String(resMissing.exitCode)}`);
  const stderrMissing = new TextDecoder().decode(resMissing.stderr).trim();
  if (stderrMissing !== "docs:links: missing value for --root")
    throw new Error(`Unexpected stderr for missing --root: ${stderrMissing}`);

  const resUnknown = Bun.spawnSync(["bun", "run", "scripts/docs-links.ts", "--unknown"], {});
  if (resUnknown.exitCode !== 2)
    throw new Error(`Expected exit 2 for unknown arg, got ${String(resUnknown.exitCode)}`);
  const stderrUnknown = new TextDecoder().decode(resUnknown.stderr).trim();
  if (stderrUnknown !== "docs:links: unknown argument: --unknown")
    throw new Error(`Unexpected stderr for unknown arg: ${stderrUnknown}`);
});

test("docs links broken case reports exactly the broken one", () => {
  const tmp = makeTmp();
  try {
    const content =
      [
        "~~~",
        "[inside](missing-inside.md)",
        "~~~",
        "",
        "Line with inline ``` code",
        "[outside](missing-outside.md)",
        "",
        '[t](good.md "title")',
        "[abs](/abs.md)",
      ].join("\n") + "\n";
    writeFileSync(join(tmp, "README.md"), content);
    writeFileSync(join(tmp, "good.md"), "# good\n");
    const broken = checkRoot(tmp);
    if (broken.length !== 1) {
      throw new Error(
        `Expected 1 broken link, got ${String(broken.length)}: ${JSON.stringify(broken)}`,
      );
    }
    const b = broken[0];
    if (!b) throw new Error("broken link missing");
    if (b.file !== "README.md") throw new Error(`Wrong file ${b.file}`);
    if (b.line !== 6) throw new Error(`Wrong line ${String(b.line)}`);
    if (b.target !== "missing-outside.md") throw new Error(`Wrong target ${b.target}`);

    const res = Bun.spawnSync(["bun", "run", "scripts/docs-links.ts", "--root", tmp], {});
    if (res.exitCode !== 1)
      throw new Error(`Expected CLI exit 1 for broken root, got ${String(res.exitCode)}`);
    const stdout = new TextDecoder().decode(res.stdout).trim();
    if (!stdout.includes("README.md:6: missing-outside.md"))
      throw new Error(`Unexpected CLI output: ${stdout}`);
  } finally {
    cleanup(tmp);
  }
});

test("nested docs, .agents and SUBMISSION.md are scanned", () => {
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, "README.md"), "[ok](docs/demo/x.md)\n");
    writeFileSync(join(tmp, "SUBMISSION.md"), "[a](missing-a.md)\n");
    mkdirSync(join(tmp, "docs/demo"), { recursive: true });
    writeFileSync(join(tmp, "docs/demo/x.md"), "x\n\n[b](../missing-b.md)\n");
    mkdirSync(join(tmp, ".agents/skills/s"), { recursive: true });
    writeFileSync(join(tmp, ".agents/skills/s/SKILL.md"), "[c](nope.md)\n");

    const broken = checkRoot(tmp);
    if (broken.length !== 3) {
      throw new Error(
        `Expected 3 broken links, got ${String(broken.length)}: ${JSON.stringify(broken)}`,
      );
    }
    const expected = [
      { file: ".agents/skills/s/SKILL.md", line: 1, target: "nope.md" },
      { file: "SUBMISSION.md", line: 1, target: "missing-a.md" },
      { file: "docs/demo/x.md", line: 3, target: "../missing-b.md" },
    ];
    expected.forEach((e, i) => {
      const b = broken[i];
      if (!b || b.file !== e.file || b.line !== e.line || b.target !== e.target) {
        throw new Error(
          `Mismatch at ${String(i)}: got ${JSON.stringify(b)}, expected ${JSON.stringify(e)}`,
        );
      }
    });
  } finally {
    cleanup(tmp);
  }
});
