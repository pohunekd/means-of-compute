// Verdict store tests (M1): the target file never exists without its
// content. A pre-existing empty temp name in the directory does not
// affect the write, and no zero-byte file is left behind.
// Mutation: create the target empty first.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuditVerdict } from "../../contracts/v1/validate.js";
import type { AuditVerdict } from "../../contracts/v1/types.js";
import { readVerdicts, VerdictConflictError, writeVerdict } from "../../src/auditor/store.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function cleanVerdict(): AuditVerdict {
  return {
    schemaVersion: "v1",
    repo: "factory/demo",
    workItemId: "w9-demo",
    pullNumber: 7,
    headSha: HEAD,
    authorModels: ["meta/muse-glimmer-30b"],
    auditorModel: "muse-spark-1.3-contributor",
    counts: { high: 0, medium: 0, low: 0 },
    findings: [],
  };
}

test("writeVerdict stores a parseable verdict and leaves no zero-byte file", async () => {
  const verdictDir = mkdtempSync(join(tmpdir(), "auditor-store-"));
  try {
    // A leftover empty temp file must not affect the write, and the
    // only files the store owns are the sha targets.
    await Bun.write(join(verdictDir, "w9-demo", `.${HEAD}.json.123.orphan.tmp`), "");
    const path = await writeVerdict(verdictDir, cleanVerdict());
    expect(path).toBe(join(verdictDir, "w9-demo", `${HEAD}.json`));
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    expect(isAuditVerdict(raw)).toBe(true);
    const owned = (await readdir(join(verdictDir, "w9-demo"))).filter(
      (name) => !name.startsWith("."),
    );
    expect(owned).toEqual([`${HEAD}.json`]);
    for (const name of owned) {
      const size = (await stat(join(verdictDir, "w9-demo", name))).size;
      expect(size).toBeGreaterThan(0);
    }
    const stored = await readVerdicts(verdictDir, "w9-demo");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.headSha).toBe(HEAD);
  } finally {
    rmSync(verdictDir, { recursive: true, force: true });
  }
});

test("writeVerdict on an existing sha refuses without touching the verdict", async () => {
  const verdictDir = mkdtempSync(join(tmpdir(), "auditor-store-conflict-"));
  try {
    await writeVerdict(verdictDir, cleanVerdict());
    let refused = false;
    try {
      await writeVerdict(verdictDir, cleanVerdict());
    } catch (error: unknown) {
      refused = error instanceof VerdictConflictError;
    }
    expect(refused).toBe(true);
    const raw = JSON.parse(
      await readFile(join(verdictDir, "w9-demo", `${HEAD}.json`), "utf8"),
    ) as unknown;
    expect(isAuditVerdict(raw)).toBe(true);
  } finally {
    rmSync(verdictDir, { recursive: true, force: true });
  }
});
