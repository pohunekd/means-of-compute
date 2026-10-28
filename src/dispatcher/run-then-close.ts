// A committed outcome must still be reported, so a close failure only warns
// and never replaces the run result.
export interface Closer {
  readonly name: string;
  readonly close: () => Promise<void>;
}

export async function runThenClose<T>(
  run: () => Promise<T>,
  closers: readonly Closer[],
  warn: (line: string) => void,
): Promise<T> {
  let outcome:
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error: unknown) {
    outcome = { ok: false, error };
  }
  for (const closer of closers) {
    try {
      await closer.close();
    } catch (error: unknown) {
      const raw = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      const code = typeof raw === "string" && /^E[A-Z]+$/.test(raw) ? raw : "failed";
      warn(`dispatch: close ${closer.name}: ${code}`);
    }
  }
  if (outcome.ok) {
    return outcome.value;
  }
  throw outcome.error;
}
