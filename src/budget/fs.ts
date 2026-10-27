// Shared input-path rules for the budget guard. Every file the guard reads
// is checked with lstat then stat: ENOENT means "absent" only when the
// parent path resolves to a directory; a missing or dangling parent, or a
// parent that is not a directory, is an error naming the path and the error
// code. A present path must be a regular file, otherwise the read is an
// error. Callers decide what "absent" means: the ledger reads it as zero
// spend, the state as empty, every other input exits 2.
import { lstat, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export class InputPathError extends Error {}

export type InputPathStatus = "absent" | "file";

export async function statInputPath(label: string, path: string): Promise<InputPathStatus> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    const code = String((error as NodeJS.ErrnoException).code);
    if (code !== "ENOENT") {
      throw new InputPathError(`${label} ${path}: cannot stat path (${code})`, { cause: error });
    }
    let parentStat;
    try {
      parentStat = await stat(dirname(path));
    } catch (parentError: unknown) {
      throw new InputPathError(
        `${label} ${path}: cannot stat parent (${String((parentError as NodeJS.ErrnoException).code)})`,
        { cause: parentError },
      );
    }
    if (!parentStat.isDirectory()) {
      throw new InputPathError(`${label} ${path}: parent is not a directory`);
    }
    return "absent";
  }
  let isRegularFile: boolean;
  try {
    isRegularFile = (await stat(path)).isFile();
  } catch (error: unknown) {
    throw new InputPathError(
      `${label} ${path}: cannot stat path (${String((error as NodeJS.ErrnoException).code)})`,
      { cause: error },
    );
  }
  if (!isRegularFile) {
    throw new InputPathError(`${label} ${path}: not a regular file`);
  }
  return "file";
}

// Directory inputs (the providers directory, log and state parent dirs)
// must exist. A missing or unreadable input exits 2; only the ledger and
// the state may be absent.
export async function requireInputDir(label: string, path: string): Promise<void> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(path)).isDirectory();
  } catch (error: unknown) {
    throw new InputPathError(
      `${label} ${path}: cannot stat path (${String((error as NodeJS.ErrnoException).code)})`,
      { cause: error },
    );
  }
  if (!isDirectory) {
    throw new InputPathError(`${label} ${path}: not a directory`);
  }
}

export async function readInputText(label: string, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    throw new InputPathError(
      `${label} ${path}: cannot read file (${String((error as NodeJS.ErrnoException).code)})`,
      { cause: error },
    );
  }
}
