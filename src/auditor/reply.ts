// Model reply parsing and validation. The reply is exactly one JSON
// object with a findings array; an extra key (for example a request to run
// a command) is a schema failure, and nothing in a reply is ever executed.
// Every finding location must resolve to a real line of a blob in the
// audited tree, otherwise the whole reply is rejected: findings are never
// dropped one by one. An empty reply, a broken reply, and a partial reply
// never become a clean verdict; only an explicit empty array does.
import Ajv from "ajv/dist/2020";
import type { AuditFinding } from "../../contracts/v1/types.js";
import type { AuditorConfig } from "./config.js";
import { InvalidModelPathError, type ReadOnlyGit } from "./git.js";
import replySchema from "./reply.schema.json" with { type: "json" };

export class AuditModelError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditModelError";
  }
}

const FENCE_PATTERN = /^```(?:json)?\n([\s\S]*)\n```$/;

interface ReplyFinding {
  severity: AuditFinding["severity"];
  location: string;
  defect: string;
  scenario: string;
  fixDirection: string;
}

function withLimits(config: AuditorConfig): unknown {
  const schema = JSON.parse(JSON.stringify(replySchema)) as {
    properties: {
      findings: {
        maxItems: number;
        items: { properties: Record<string, { maxLength?: number }> };
      };
    };
  };
  schema.properties.findings.maxItems = config.maxFindings;
  const props = schema.properties.findings.items.properties;
  for (const key of ["defect", "scenario", "fixDirection"]) {
    const field = props[key];
    if (field !== undefined) {
      field.maxLength = config.maxFieldChars;
    }
  }
  return schema;
}

function lineCountOf(blob: string): number {
  if (blob === "") {
    return 0;
  }
  return blob.split("\n").length - (blob.endsWith("\n") ? 1 : 0);
}

export async function parseReply(
  content: string,
  headSha: string,
  git: ReadOnlyGit,
  config: AuditorConfig,
): Promise<readonly AuditFinding[]> {
  const fenced = content.trim().match(FENCE_PATTERN);
  const text = (fenced?.[1] ?? content).trim();
  if (text === "") {
    throw new AuditModelError("empty reply");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new AuditModelError("reply is not JSON");
  }
  const ajv = new Ajv({ strict: true });
  const validate = ajv.compile(withLimits(config) as object);
  if (!validate(raw)) {
    throw new AuditModelError(`reply fails the reply schema: ${ajv.errorsText(validate.errors)}`);
  }
  const findings = (raw as { findings: ReplyFinding[] }).findings;
  const checked: AuditFinding[] = [];
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index] as ReplyFinding;
    const location = finding.location;
    const colon = location.lastIndexOf(":");
    const path = location.slice(0, colon);
    const line = Number(location.slice(colon + 1));
    let blob: string | null;
    let lines = 0;
    try {
      blob = await git.blobAt(headSha, path);
      if (blob !== null) {
        lines = lineCountOf(blob);
      }
    } catch (error: unknown) {
      if (error instanceof InvalidModelPathError) {
        blob = null;
      } else {
        throw new AuditModelError(
          `finding ${String(index)} location ${location} is not in the tree at ${headSha}`,
          { cause: error },
        );
      }
    }
    if (blob === null || !Number.isSafeInteger(line) || line < 1 || line > lines) {
      throw new AuditModelError(
        `finding ${String(index)} location ${location} is not in the tree at ${headSha}`,
      );
    }
    checked.push({
      severity: finding.severity,
      location,
      defect: finding.defect,
      scenario: finding.scenario,
      fixDirection: finding.fixDirection,
    });
  }
  return checked;
}
