// Auditor model choice. Without the phase-critical opt-in, the auditor
// is the first configured entry whose model is not among the author
// models, so a model never audits its own work. With it, the auditor is
// the merge auditor unless Wonder authored the item. Neither path falls
// back to the other, and the merge auditor is never in the provider route.
import type { AuditorEntry } from "./config.js";

export class NoEligibleAuditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoEligibleAuditorError";
  }
}

export function selectMergeAuditor(
  mergeAuditor: AuditorEntry,
  authors: readonly string[],
  workItemId: string,
): AuditorEntry {
  if (authors.includes(mergeAuditor.model)) {
    throw new NoEligibleAuditorError(
      `no eligible auditor: merge auditor ${mergeAuditor.model} authored ${workItemId}`,
    );
  }
  return mergeAuditor;
}

// The first configured auditor whose model did not author the item, or null.
export function eligibleAuditor(
  auditors: readonly AuditorEntry[],
  authors: readonly string[],
): AuditorEntry | null {
  const authored = new Set(authors);
  return auditors.find((entry) => !authored.has(entry.model)) ?? null;
}

export function selectAuditor(
  auditors: readonly AuditorEntry[],
  authors: readonly string[],
  workItemId: string,
): AuditorEntry {
  const entry = eligibleAuditor(auditors, authors);
  if (entry === null) {
    throw new NoEligibleAuditorError(
      `no eligible auditor: every configured auditor model authored ${workItemId}`,
    );
  }
  return entry;
}
