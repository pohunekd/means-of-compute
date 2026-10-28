// Coordinator goal loader: JSON file validated against the goal schema,
// then checked against the runtime limits and configured repos and models.
import Ajv from "ajv/dist/2020";
import type { FactorySpec } from "../../contracts/v1/types.js";
import { readInputText, statInputPath } from "../fs/input.js";
import type { WorkConfig } from "../work/config.js";
import goalSchema from "./goal.schema.json" with { type: "json" };

export interface GoalIssue {
  readonly number: number;
  readonly title: string;
}

export interface Goal {
  readonly schemaVersion: "v1";
  readonly goalId: string;
  readonly idPrefix: string;
  readonly repo: string;
  readonly title: string;
  readonly outcome: string;
  readonly constraints: readonly string[];
  readonly issues: readonly GoalIssue[];
  readonly maxItems: number;
  readonly preferredModel: string;
}

export class GoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalError";
  }
}

export interface GoalContext {
  readonly maxOutcomeChars: number;
  readonly workConfig: WorkConfig;
  readonly specs: readonly FactorySpec[];
}

const ajv = new Ajv({ strict: true });
const validateGoal = ajv.compile(goalSchema);

function firstSchemaError(): string {
  const errors = validateGoal.errors ?? [];
  const first = errors[0] as { instancePath?: string; keyword?: string } | undefined;
  const path =
    first?.instancePath === "" || first?.instancePath === undefined ? "/" : first.instancePath;
  return `invalid at ${path} (${String(first?.keyword)})`;
}

export async function loadGoal(path: string, ctx: GoalContext): Promise<Goal> {
  const label = `Goal ${path}`;
  if ((await statInputPath(label, path)) === "absent") {
    throw new GoalError(`${label}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new GoalError(`${label}: not valid JSON`);
  }
  if (!validateGoal(raw)) {
    throw new GoalError(`${label}: ${firstSchemaError()}`);
  }
  const goal = raw as unknown as Goal;
  const seen = new Set<number>();
  for (const issue of goal.issues) {
    if (seen.has(issue.number)) {
      throw new GoalError(`${label}: duplicate issue ${String(issue.number)}`);
    }
    seen.add(issue.number);
  }
  if ([...goal.outcome].length > ctx.maxOutcomeChars) {
    throw new GoalError(`${label}: outcome exceeds ${String(ctx.maxOutcomeChars)} characters`);
  }
  if (goal.maxItems > ctx.workConfig.maxItemsPerSubmit) {
    throw new GoalError(
      `${label}: maxItems exceeds maxItemsPerSubmit ${String(ctx.workConfig.maxItemsPerSubmit)}`,
    );
  }
  if (!ctx.specs.some((spec) => spec.repo === goal.repo)) {
    throw new GoalError(`${label}: repo ${goal.repo} is not configured`);
  }
  if (!ctx.workConfig.models.includes(goal.preferredModel)) {
    throw new GoalError(`${label}: preferredModel ${goal.preferredModel} is not allowed`);
  }
  return goal;
}
