// Verdict files for #15 audit_results and #17: one JSON file per audited
// head at <verdictDir>/<workItemId>/<headSha>.json. Stored verdicts are
// validated against the AuditVerdict contract on read.
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { contractErrors, isAuditVerdict } from "../../contracts/v1/validate.js";
import type { AuditVerdict } from "../../contracts/v1/types.js";
import { HEX40_PATTERN } from "./git.js";
import { requireInputDir } from "../fs/input.js";
import { writeFileAtomic } from "../fs/write.js";

export class VerdictConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictConflictError";
  }
}

const WORK_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// The per-item directory is created with mkdir: an existing directory is
// fine, anything else exits 2.
async function itemDirOf(verdictDir: string, workItemId: string): Promise<string> {
  await requireInputDir("Verdict dir", verdictDir);
  if (!WORK_ITEM_ID_PATTERN.test(workItemId)) {
    throw new Error(`Verdict store: invalid workItemId ${JSON.stringify(workItemId)}`);
  }
  const dir = `${verdictDir}/${workItemId}`;
  try {
    await mkdir(dir, { recursive: false });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`Verdict store ${dir}: cannot create directory`, { cause: error });
    }
  }
  await requireInputDir("Verdict store", dir);
  return dir;
}

// The verdict body is written to a random temp name, then hard-linked to
// the sha target: link(2) fails with EEXIST when another audit already
// claimed this sha, which closes the race in runAudit step 13. A crash
// never leaves a half-written verdict file behind.
async function claimVerdictFile(dir: string, name: string, text: string): Promise<string> {
  const target = `${dir}/${name}`;
  const temp = `${dir}/.${name}.${String(process.pid)}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, target);
  } catch (error: unknown) {
    try {
      await unlink(temp);
    } catch {
      // The temp cleanup failure adds nothing to the claim error.
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new VerdictConflictError(`verdict exists for ${name.replace(/\.json$/, "")}`);
    }
    throw new Error(`Verdict store ${target}: cannot claim verdict file`, { cause: error });
  }
  try {
    await unlink(temp);
  } catch {
    // The target holds the verdict; a leftover temp adds nothing.
  }
  return target;
}

export async function writeVerdict(verdictDir: string, verdict: AuditVerdict): Promise<string> {
  if (!isAuditVerdict(verdict)) {
    throw new Error(
      `Verdict store: verdict fails the AuditVerdict contract ${JSON.stringify(contractErrors("audit-verdict", verdict))}`,
    );
  }
  const dir = await itemDirOf(verdictDir, verdict.workItemId);
  const path = await claimVerdictFile(dir, `${verdict.headSha}.json`, "");
  await writeFileAtomic("Verdict store", path, `${JSON.stringify(verdict, null, 2)}\n`);
  return path;
}

export async function readVerdicts(
  verdictDir: string,
  workItemId: string,
): Promise<readonly AuditVerdict[]> {
  await requireInputDir("Verdict dir", verdictDir);
  if (!WORK_ITEM_ID_PATTERN.test(workItemId)) {
    throw new Error(`Verdict store: invalid workItemId ${JSON.stringify(workItemId)}`);
  }
  const dir = `${verdictDir}/${workItemId}`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new Error(`Verdict store ${dir}: cannot list directory`, { cause: error });
  }
  const verdicts: AuditVerdict[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || !HEX40_PATTERN.test(name.slice(0, -".json".length))) {
      continue;
    }
    const text = await readFile(`${dir}/${name}`, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Verdict store ${dir}/${name}: not valid JSON`);
    }
    if (!isAuditVerdict(raw)) {
      throw new Error(
        `Verdict store ${dir}/${name}: invalid verdict ${JSON.stringify(contractErrors("audit-verdict", raw))}`,
      );
    }
    if (raw.workItemId !== workItemId) {
      throw new Error(`Verdict store ${dir}/${name}: workItemId mismatch`);
    }
    verdicts.push(raw);
  }
  return verdicts;
}
