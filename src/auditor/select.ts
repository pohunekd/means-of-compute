// Auditor model choice. The auditor is the first configured entry whose
// model is not among the author models, so a model never audits its own
// work. A refusal means every configured auditor authored the item.
import type { AuditorEntry } from "./config.js";

export class NoEligibleAuditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoEligibleAuditorError";
  }
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
