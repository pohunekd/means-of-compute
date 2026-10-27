// Atomic write helpers. Reads stay in src/fs/input.ts; this module owns
// every write. A write target must pass requireWritableTarget before any
// change, and writeFileAtomic applies the whole file in one rename so a
// crash never leaves a half-written file.
import { access, constants, open, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { InputPathError, requireInputDir, statInputPath } from "./input.js";

export async function requireWritableTarget(label: string, path: string): Promise<void> {
  await requireInputDir(label, dirname(path));
  const status = await statInputPath(label, path);
  const target = status === "absent" ? dirname(path) : path;
  try {
    await access(target, constants.W_OK);
  } catch (error: unknown) {
    throw new InputPathError(
      `${label} ${path}: not writable (${String((error as NodeJS.ErrnoException).code)})`,
      { cause: error },
    );
  }
}

export async function writeFileAtomic(label: string, path: string, text: string): Promise<void> {
  await requireWritableTarget(label, path);
  const temp = join(dirname(path), `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, path);
    const dirHandle = await open(dirname(path), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (error: unknown) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // The original error carries the failure; a close error adds nothing.
      }
    }
    try {
      await unlink(temp);
    } catch (unlinkError: unknown) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
        (error as { cause?: unknown }).cause = unlinkError;
      }
    }
    if (error instanceof InputPathError) {
      throw error;
    }
    throw new InputPathError(
      `${label} ${path}: cannot write file (${String((error as NodeJS.ErrnoException).code)})`,
      { cause: error },
    );
  }
}
