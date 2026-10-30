import { test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { checkRoot } from "../scripts/docs-links";

function makeTmp() {
  const tmp = mkdtempSync(join(import.meta.dir, "tmp-docs-"));
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
  } finally {
    cleanup(tmp);
  }
});
