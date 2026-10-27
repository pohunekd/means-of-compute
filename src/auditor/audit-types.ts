// Shared audit input and dependency types. Kept separate so verdict.ts
// can build a verdict without importing the orchestration module.
import type { WorkItem } from "../../contracts/v1/types.js";
import type { BudgetGate } from "../budget/gate.js";
import type { AuditorConfig } from "./config.js";
import type { ReadOnlyGit } from "./git.js";
import type { SingleCallResult, ModelRequest } from "../providers/router.js";

export interface AuditInput {
  readonly item: WorkItem;
  readonly repoDir: string;
  readonly ref: string;
  readonly baseRef: string;
  readonly pullNumber: number | null;
  readonly authorModels: readonly string[];
}

export interface AuditDeps {
  readonly config: AuditorConfig;
  readonly git: ReadOnlyGit;
  readonly budget: BudgetGate;
  readonly call: (providerId: string, request: ModelRequest) => Promise<SingleCallResult>;
  readonly ledgerPath: string;
  readonly now: () => Date;
}
