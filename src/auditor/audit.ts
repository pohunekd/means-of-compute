// Audit orchestration: the fourteen steps of design 2.1 in order. Each
// step stops the run as listed: exit 2 for input, config, internal or
// data errors, 3 for domain refusals, 4 for model, provider or post
// failures. Usage is recorded before the reply is judged, so a rejected
// reply still counts as spend. No path yields a verdict without a valid
// model reply.
import { randomUUID } from "node:crypto";
import { contractErrors, isAuditVerdict, isWorkItem } from "../../contracts/v1/validate.js";
import type { AuditFinding } from "../../contracts/v1/types.js";
import { appendPending } from "../ledger/store.js";
import { AUDITOR_USAGE_SOURCE } from "../ledger/types.js";
import { HEX40_PATTERN, GitReadError } from "./git.js";
import type { AuditDeps, AuditInput } from "./audit-types.js";
import { buildVerdict, recount, renderComment } from "./verdict.js";
import { AuditModelError, parseReply } from "./reply.js";
import { buildPrompt } from "./prompt.js";
import { NoEligibleAuditorError, selectAuditor } from "./select.js";
import { readVerdicts, VerdictConflictError, writeVerdict } from "./store.js";
import { ProviderCallError, ProviderError } from "../providers/router.js";
import { BudgetGateError } from "../budget/gate.js";

export type AuditOutcome =
  | {
      readonly kind: "verdict";
      readonly verdict: ReturnType<typeof buildVerdict>;
      readonly comment: string | null;
      readonly path: string;
    }
  | { readonly kind: "refused"; readonly reason: string };

function refused(reason: string): AuditOutcome {
  return { kind: "refused", reason };
}

function toExitCode(error: unknown): 2 | 3 | 4 {
  if (error instanceof VerdictConflictError) {
    return 3;
  }
  if (error instanceof NoEligibleAuditorError) {
    return 3;
  }
  if (error instanceof AuditModelError) {
    return 4;
  }
  if (error instanceof ProviderError) {
    return 4;
  }
  if (error instanceof BudgetGateError) {
    return 2;
  }
  if (error instanceof GitReadError) {
    return 2;
  }
  return 2;
}

interface AuditorUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

// One ledger entry per provider call that may be billed, on success
// and on failure alike. An append failure is exit 2, never a verdict.
async function recordAuditUsage(
  ledgerPath: string,
  workItemId: string,
  auditor: { providerId: string; model: string },
  usage: AuditorUsage | null,
  now: () => Date,
): Promise<void> {
  try {
    await appendPending(ledgerPath, {
      entryId: `${workItemId}:audit:${randomUUID()}`,
      kind: "audit",
      workItemId,
      finishedAt: now().toISOString(),
      startModel: auditor.model,
      tokens: [
        {
          provider: auditor.providerId,
          model: auditor.model,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          requests: 1,
          source: AUDITOR_USAGE_SOURCE,
        },
      ],
      session: null,
    });
  } catch (error: unknown) {
    throw new Error(
      `audit: cannot record usage: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function runAudit(input: AuditInput, deps: AuditDeps): Promise<AuditOutcome> {
  // No DoD, no audit: an item without acceptance criteria is a domain
  // refusal, checked before contract validation so it never reaches a
  // model call.
  const rawDod: unknown = (input.item as unknown as { dod?: unknown }).dod;
  if (Array.isArray(rawDod) && rawDod.length === 0) {
    return refused("no definition of done: nothing to audit");
  }
  if (!isWorkItem(input.item)) {
    throw new Error(
      `audit: invalid work item ${JSON.stringify(contractErrors("work-item", input.item))}`,
    );
  }
  if (
    input.pullNumber !== null &&
    (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1)
  ) {
    throw new Error(`audit: invalid pull number ${JSON.stringify(input.pullNumber)}`);
  }

  let headSha: string;
  let baseSha: string;
  try {
    headSha = await deps.git.resolveCommit(input.ref);
    baseSha = await deps.git.mergeBase(await deps.git.resolveCommit(input.baseRef), headSha);
  } catch (error: unknown) {
    if (error instanceof GitReadError) {
      throw new Error(`audit: ${error.message}`, { cause: error });
    }
    throw error;
  }
  if (!HEX40_PATTERN.test(headSha) || !HEX40_PATTERN.test(baseSha)) {
    throw new Error(`audit: git returned a non-sha head ${headSha} or base ${baseSha}`);
  }

  const files = await deps.git.changedFiles(baseSha, headSha);
  if (files.length === 0) {
    return refused(`nothing to audit at ${headSha}`);
  }
  const diff = await deps.git.unifiedDiff(baseSha, headSha);
  if (Buffer.byteLength(diff, "utf8") > deps.config.maxDiffBytes) {
    return refused(
      `diff too large for one audit (${String(Buffer.byteLength(diff, "utf8"))} > ${String(deps.config.maxDiffBytes)} bytes)`,
    );
  }

  const stored = await readVerdicts(deps.config.verdictDir, input.item.id);
  if (stored.some((verdict) => verdict.headSha === headSha)) {
    return refused(`verdict exists for ${headSha}`);
  }

  const authors = [...new Set(input.authorModels)].sort();
  if (authors.length === 0) {
    return refused(`no author models recorded for ${input.item.id}`);
  }
  let auditor: { providerId: string; model: string };
  try {
    auditor = selectAuditor(deps.config.auditors, authors, input.item.id);
  } catch (error: unknown) {
    if (error instanceof NoEligibleAuditorError) {
      return refused(error.message);
    }
    throw error;
  }

  let admission: Awaited<ReturnType<AuditDeps["budget"]["admit"]>>;
  try {
    admission = await deps.budget.admit();
  } catch (error: unknown) {
    if (error instanceof BudgetGateError) {
      throw new Error(`audit: ${error.message}`, { cause: error });
    }
    throw error;
  }
  if (!admission.admit) {
    return refused(`budget: ${admission.reason}`);
  }

  let call: Awaited<ReturnType<AuditDeps["call"]>>;
  try {
    call = await deps.call(auditor.providerId, buildPrompt(input.item, files, diff, deps.config));
  } catch (error: unknown) {
    // A call that reached the provider may be billed even though it
    // failed, so it reaches the ledger before the error maps to 4.
    if (
      error instanceof ProviderCallError &&
      error.reachedProvider
    ) {
      await recordAuditUsage(deps.ledgerPath, input.item.id, auditor, error.usage, deps.now);
    }
    if (
      error instanceof ProviderError ||
      (error instanceof Error && (error.name === "AbortError" || error instanceof TypeError))
    ) {
      throw new AuditModelError(
        `audit: model call failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    throw error;
  }

  await recordAuditUsage(
    deps.ledgerPath,
    input.item.id,
    auditor,
    { inputTokens: call.inputTokens, outputTokens: call.outputTokens },
    deps.now,
  );

  let findings: readonly AuditFinding[];
  try {
    findings = await parseReply(call.content, headSha, deps.git, deps.config);
  } catch (error: unknown) {
    if (error instanceof AuditModelError) {
      throw error;
    }
    throw new AuditModelError(
      `audit: invalid model reply: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const verdictInput = { ...input, authorModels: authors };
  const verdict = buildVerdict(verdictInput, headSha, auditor.model, findings);
  if (
    !isAuditVerdict(verdict) ||
    verdict.authorModels.includes(verdict.auditorModel) ||
    !Bun.deepEquals(verdict.counts, recount(verdict.findings), true)
  ) {
    throw new Error("audit: built verdict fails the self-check");
  }

  let path: string;
  try {
    path = await writeVerdict(deps.config.verdictDir, verdict);
  } catch (error: unknown) {
    if (error instanceof VerdictConflictError) {
      return refused(`verdict exists for ${headSha}`);
    }
    throw new Error(
      `audit: cannot store verdict: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return { kind: "verdict", verdict, comment: renderComment(verdict), path };
}

export function auditExitCode(error: unknown): 2 | 3 | 4 {
  return toExitCode(error);
}
