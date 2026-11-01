// Intake slice: import ready GitHub issues as queued work items. The goal
// text pins at import time; later edits of the issue body change nothing.
import type { WorkItem, WorkItemDod } from "../../contracts/v1/types.js";
import { isWorkItem } from "../../contracts/v1/validate.js";
import { canonicalJson } from "../work/canonical.js";
import { readWorkStore, updateWorkStore, WorkStoreBusyError } from "../work/store.js";
import type { LoopIntakeConfig, LoopRepoConfig } from "./config.js";
import { GitHubError, type GitHubPort, type IntakeIssue } from "./github.js";
import type { LoopLog } from "./log.js";

export interface IntakeContext {
  readonly github: GitHubPort;
  readonly storePath: string;
  readonly repos: readonly LoopRepoConfig[];
  readonly intake: LoopIntakeConfig;
  readonly trustedAssociations: readonly string[];
  readonly maxItemBytes: number;
  readonly log: LoopLog;
  readonly now: () => Date;
}

export interface IntakeState {
  lastPollAt: number | null;
  readonly tracked: Set<string>;
}

export function createIntakeState(): IntakeState {
  return { lastPollAt: null, tracked: new Set() };
}

function sectionLines(body: string, name: string): string[] {
  const lines = body.split("\n");
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === `## ${name}`) {
      inside = true;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      if (inside) {
        break;
      }
      continue;
    }
    if (inside) {
      collected.push(line);
    }
  }
  return collected;
}

export function parseIssueDod(body: string): readonly WorkItemDod[] | null {
  const items: WorkItemDod[] = [];
  const seen = new Set<string>();
  for (const line of sectionLines(body, "DoD")) {
    const match = /^- (D[0-9]+): (\S.*)$/.exec(line.trimEnd());
    const id = match?.[1];
    const text = match?.[2];
    if (match === null || id === undefined || text === undefined) {
      continue;
    }
    if (seen.has(id)) {
      return null;
    }
    seen.add(id);
    items.push({ id, text, done: false });
  }
  return items.length > 0 ? items : null;
}

export function dependencyNumbers(body: string): readonly number[] {
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const line of sectionLines(body, "Dependencies")) {
    for (const match of line.matchAll(/#([1-9][0-9]*)/g)) {
      const raw = match[1];
      if (raw === undefined) {
        continue;
      }
      const number = Number(raw);
      if (!seen.has(number)) {
        seen.add(number);
        numbers.push(number);
      }
    }
  }
  return numbers;
}

export function intakeItem(
  repo: string,
  idPrefix: string,
  issue: IntakeIssue,
  defaultModel: string,
): WorkItem {
  return {
    schemaVersion: "v1",
    id: `gh-${idPrefix}-${String(issue.number)}`,
    repo,
    title: issue.title,
    goal: issue.body,
    issue: issue.number,
    dod: parseIssueDod(issue.body) ?? [],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: defaultModel, attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
  };
}

export async function runIntake(
  ctx: IntakeContext,
  state: IntakeState,
): Promise<readonly string[]> {
  const appended: string[] = [];
  if (!ctx.intake.enabled) {
    return appended;
  }
  const at = ctx.now().getTime();
  if (state.lastPollAt !== null && at - state.lastPollAt < ctx.intake.pollMs) {
    return appended;
  }
  state.lastPollAt = at;
  for (const repo of ctx.repos) {
    let issues: readonly IntakeIssue[];
    try {
      issues = await ctx.github.readyIssues(repo.repo, [
        ctx.intake.optInLabel,
        ctx.intake.readyLabel,
      ]);
    } catch (error: unknown) {
      if (error instanceof GitHubError) {
        ctx.log.log({ event: "github-error", code: error.kind, detail: error.step });
        continue;
      }
      throw error;
    }
    let repoDone = false;
    for (const issue of issues) {
      const detail = `${repo.repo}#${String(issue.number)}`;
      if (
        issue.isPullRequest ||
        !issue.labels.includes(ctx.intake.optInLabel) ||
        !issue.labels.includes(ctx.intake.readyLabel)
      ) {
        ctx.log.log({
          event: "intake-skip",
          code: issue.isPullRequest ? "is-pull-request" : "labels",
          detail,
        });
        continue;
      }
      if (!ctx.trustedAssociations.includes(issue.authorAssociation)) {
        ctx.log.log({ event: "intake-skip", code: "untrusted-author", detail });
        continue;
      }
      const id = `gh-${repo.idPrefix}-${String(issue.number)}`;
      const store = await readWorkStore(ctx.storePath);
      if (store.items.some((item) => item.id === id)) {
        continue;
      }
      if (store.items.some((item) => item.repo === repo.repo && item.issue === issue.number)) {
        if (!state.tracked.has(detail)) {
          state.tracked.add(detail);
          ctx.log.log({ event: "intake-skip", code: "issue-tracked", detail });
        }
        continue;
      }
      const dod = parseIssueDod(issue.body);
      if (dod === null) {
        ctx.log.log({ event: "intake-skip", code: "no-dod", detail });
        continue;
      }
      let blocked = false;
      for (const number of dependencyNumbers(issue.body)) {
        try {
          const dependencyState = await ctx.github.issueState(repo.repo, number);
          if (dependencyState === "open") {
            ctx.log.log({ event: "intake-skip", code: "open-dependency", detail });
            blocked = true;
            break;
          }
        } catch (error: unknown) {
          if (error instanceof GitHubError && error.kind === "rejected") {
            ctx.log.log({ event: "intake-skip", code: "open-dependency", detail });
            blocked = true;
            break;
          }
          if (error instanceof GitHubError) {
            ctx.log.log({ event: "github-error", code: error.kind, detail: error.step });
            repoDone = true;
            break;
          }
          throw error;
        }
      }
      if (repoDone || blocked) {
        if (repoDone) {
          break;
        }
        continue;
      }
      const item = intakeItem(repo.repo, repo.idPrefix, issue, ctx.intake.defaultModel);
      if (
        Array.from(issue.body).length > ctx.intake.maxGoalChars ||
        Buffer.byteLength(canonicalJson(item), "utf8") > ctx.maxItemBytes ||
        !isWorkItem(item)
      ) {
        ctx.log.log({
          event: "intake-skip",
          code:
            Array.from(issue.body).length > ctx.intake.maxGoalChars ||
            Buffer.byteLength(canonicalJson(item), "utf8") > ctx.maxItemBytes
              ? "too-large"
              : "invalid-item",
          detail,
        });
        continue;
      }
      let appendedNow: boolean;
      try {
        appendedNow = await updateWorkStore(ctx.storePath, (current) => {
          if (
            current.items.some((entry) => entry.id === id) ||
            current.items.some((entry) => entry.repo === repo.repo && entry.issue === issue.number)
          ) {
            return Promise.resolve({ next: null, value: false });
          }
          return Promise.resolve({
            next: { items: [...current.items, item], submissions: current.submissions },
            value: true,
          });
        });
      } catch (error: unknown) {
        if (error instanceof WorkStoreBusyError) {
          return appended;
        }
        throw error;
      }
      if (!appendedNow) {
        continue;
      }
      appended.push(id);
      ctx.log.log({ event: "intake-import", workItemId: id, detail });
    }
    if (repoDone) {
      continue;
    }
  }
  return appended;
}
