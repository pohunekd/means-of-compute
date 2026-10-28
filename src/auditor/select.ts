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

export function selectAuditor(
  auditors: readonly AuditorEntry[],
  authors: readonly string[],
  workItemId: string,
): AuditorEntry {
  const authored = new Set(authors);
  for (const entry of auditors) {
    if (!authored.has(entry.model)) {
      return entry;
    }
  }
  throw new NoEligibleAuditorError(
    `no eligible auditor: every configured auditor model authored ${workItemId}`,
  );
}
