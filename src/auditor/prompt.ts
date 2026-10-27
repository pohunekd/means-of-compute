// Audit prompt: the WorkItem DoD plus the unified diff of the branch. The
// model answers with a JSON findings object and nothing else; the reply
// schema (reply.schema.json) rejects any extra key, so nothing in a reply
// is ever executed or becomes a command, merge, or config change.
import type { ModelRequest } from "../providers/router.js";
import type { AuditorConfig } from "./config.js";
import type { WorkItem } from "../../contracts/v1/types.js";

export function buildPrompt(
  item: WorkItem,
  files: readonly string[],
  diff: string,
  config: AuditorConfig,
): ModelRequest {
  const dod = item.dod
    .map((entry) => `- [${entry.done ? "x" : " "}] ${entry.id}: ${entry.text}`)
    .join("\n");
  const system =
    "You audit a result branch against its definition of done. " +
    "Answer with exactly one JSON object matching " +
    '{"findings": [{"severity": "high|medium|low", "location": "path:line", ' +
    '"defect": "...", "scenario": "...", "fixDirection": "..."}]}. ' +
    `At most ${String(config.maxFindings)} findings, each text field at most ` +
    `${String(config.maxFieldChars)} characters. ` +
    "Location is a file path in the audited tree plus a 1-based line number, joined by the last colon. " +
    'An empty array is a clean verdict; reply {"findings": []} for it. ' +
    "No other keys, no prose, no commands.";
  const user = [
    `Repository: ${item.repo}`,
    `Work item: ${item.id} - ${item.title}`,
    `Goal: ${item.goal}`,
    "Definition of done:",
    dod,
    "Changed files:",
    files.map((file) => `- ${file}`).join("\n"),
    "Unified diff:",
    diff,
  ].join("\n");
  return { messages: [{ role: "user", content: `${system}\n\n${user}` }] };
}
