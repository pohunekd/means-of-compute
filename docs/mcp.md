# MCP server (core slice)

One server process per coordinator run (`bun run mcp:serve --caller
<name> [--config <path>]`). The transport is hand-written JSON-RPC 2.0 over
stdio: stdin splits on `0x0A` (one `0x0D` stripped), empty lines are
skipped, a line over `maxMessageBytes` answers `{"jsonrpc":"2.0","id":null,
"error":{"code":-32600,"message":"message too large"}}` and the next line
is still answered. No MCP SDK: the SDK tree pulls an HTTP stack a
stdio-only server never loads, and its stdio transport drops unparsable
lines silently. Responses serialize through one in-process queue, so two
overlapping `tools/call` requests run in order (call-start 2 is logged
after call-end 1).

## Lifecycle

Startup: parse args (`--caller` exactly once, `--config` at most once,
default `config/mcp.json`), load the MCP config, require the caller in
`callers`, load the work, auditor, dispatcher and approvals configs plus factory
specs, `requireWritableTarget` for the call log, store and approval
requests paths, `requireInputDir` for the verdict dir, open the call log,
append
`server-start`, print `mcp: serving as <caller>` to stderr. Any failure
exits 2 with empty stdout. Stdout carries only JSON-RPC messages;
diagnostics go to stderr; no `console.log` runs in a server file.

Shutdown: stdin EOF processes every complete line plus a final
non-empty unterminated line, writes the responses, appends `server-stop
{reason:"eof"}` and exits 0. SIGTERM/SIGINT lets the message in flight
finish (handler, call-end line, response), drops lines that have not
started, appends `server-stop {reason:"signal"}` and exits 0. A stdout
write error stops responses and exits 0 with `server-stop
{reason:"stdout-closed"}`. An uncaught exception outside a tool handler
exits 1; a handler exception is a tool result, never an exit.

## Protocol

`initialize` negotiates: an offered version inside
`["2025-11-25","2025-06-18","2025-03-26","2024-11-05"]` is echoed, anything
else falls back to `"2025-11-25"`. Only a non-string `clientInfo.name` is
`-32602`; an empty name initializes with `client` null, like any other
pattern mismatch. A hostile name fails the client pattern `^[\x20-\x7e]{1,64}$` and is logged
as `null` client, never raw. The initialized flag flips only on an
`initialize` response; `notifications/initialized` and every other
notification produce no output. `tools/list` and `tools/call` before the
initialized flag are `-32600 "server not
initialized"`. `tools/list` answers in PR order `fleet_status, list_work, audit_results, submit_work, approve, pause_fleet, resolve_session`.
Unknown methods are `-32601`, unknown tools are
`-32602 "Unknown tool: <name>"`, batch arrays are `-32600 "batch not
supported"`, unparsable lines are `-32700 "parse error"`. Every JSON-RPC
error response also appends a `protocol-error` line with `jsonrpcCode`.

`config/mcp.json` (`loadMcpConfig`): `serverInfo`, `callers` (pattern
`^[a-z][a-z0-9-]{0,31}$`, unique), `callLogPath`, `maxMessageBytes`
(1024-16777216), `clientTimeoutMs` (1-600000), `workConfigPath`,
`auditorConfigPath`, `dispatcherConfigPath`, `approvalsConfigPath` (the
approvals config from `config/approvals.json`). Every key is required, no
extra key is allowed.

## Call log

`logs/mcp-calls.jsonl` (`openCallLog`): one `open(path, "a", 0o600)`,
every entry one `write` of one JSON line plus `datasync` through a single
in-process chain. Events: `server-start` (`ts, event, run, caller, pid`),
`session-init` (`ts, event, run, caller, client, protocolVersion`),
`call-start` (`ts, event, run, callId, caller, client, tool, class,
argsSha256, argsBytes`), `call-end` (`ts, event, run, callId, caller,
tool, class, outcome (ok|refused|error), code|null, durationMs,
summary|null, detail|null`), `protocol-error` (`ts, event, run, caller, jsonrpcCode, method|null,
tool|null`), `server-stop` (`ts, event, run,
reason`). A failed append latches the log: later `tools/call` requests
return `call-log-unavailable` without running the handler; a `call-end`
that fails still returns its payload, because the call already happened.
If `server-start` cannot be logged, the server exits 2.

## Read tools

`fleet_status` (`[read]`, no arguments): work items by status from the
work store, `openSessions` (registry entries with `terminal: null`), and
the `fleet` field (`paused`, `pausedBy`, `pendingRequests` in seq order
from `readApprovals`). It reads only `storePath`, `registryPath` and
`requestsPath` from the work, dispatcher and approvals configs, so an
unknown provider model never fails it. Any failing source is
`source-unreadable` naming the source; out-of-scope items fail dispatch,
never this tool.

`list_work` (`[read]`, `{"status":[...]}`): filtered work items. Input
requires `status` (array, minItems 1, uniqueItems true, enum
`queued|running|review|parked|blocked|done`). Output
`{"ok":true,"revision":n,"items":[row...]}` where rows are store items
whose status is in the filter, in store order. Each row is
`{id,repo,title,issue,status,statusReason,assignedHostAlias,branch,pullNumber,
dependencies,dod:{done,total},retryCount,stallRounds,modelRouting}`; `goal`
and DoD texts are not returned. Errors: `source-unreadable` on store
unreadable; invalid arguments are `invalid-arguments`.

`audit_results` (`[read]`, `{"workItemId":id}`): stored verdicts. Steps:

1. unknown `workItemId` in work store → `unknown-work-item`
   `"unknown work item <id>"`; 2) `readVerdicts` throws →
   `source-unreadable` `{source:"verdicts"}`; 3) any verdict where
   `recount(findings)` differs from `counts` → `verdict-invalid`
   `{headSha}` `"verdict <sha> counts disagree with its findings"`; 4)
   otherwise `{"ok":true,"workItemId":id,"verdicts":[...]}` in
   `readVerdicts` order (by `headSha`). Zero verdicts is `[]`.

## `submit_work`

`submit_work` (`[write]`, `{"items":[...]}`): queues a DAG of
WorkItems after validation. The advertised `inputSchema` embeds the
WorkItem schema per item with no `maxItems`; `validate` checks only
the envelope (`items` array, `minItems` 1). The description notes the
`maxItemsPerSubmit` limit from `config/work.json`. `run` loads the
work config, then the factory specs (`source-unreadable` naming
`work-store` or `factory-specs` with the message in `detail`), refuses
more than `maxItemsPerSubmit` items as `invalid-arguments` at `/items`
(`maxItems`), runs the S2 predicates in order, and folds steps 7-12
through `updateWorkStore`. The tool never reads the pause state, so
intake continues while paused.

Predicates, first failure wins: `item-too-large` (`index`, `limit`)
when `Buffer.byteLength(canonicalJson(item))` exceeds `maxItemBytes`;
`contract-invalid` (`index`, `path`, `keyword`) from the first
`contractErrors("work-item")` error; `loop-state-not-initial`
(`index`, `id`, `field`) for any non-initial queue field (`status`,
`statusReason`, `assignedHostAlias`, `branch`, `pullNumber`,
`retryCount`, `stallRounds`, `modelRouting.attempts`,
`modelRouting.fallbackUsed`, first `dod[k].done`); `repo-not-configured`
(`index`, `id`, `repo`); `model-not-allowed` (`index`, `id`, `model`);
`duplicate-id` (`id`, `indices:[i,j]` for the first `i < j` pair);
replay (`replayed:true` with the stored `submissionId`, no write) when
`sha256:` plus the canonical digest matches a stored submission; `id-exists`
(`ids` in submission order, no write); `unknown-dependency` (`edge`) for
the first dependency naming neither a sibling nor a store id;
`dag-cycle` (`edge`, `cycle`) from `findCycle` over submission edges
only; `store-full` (`limit`) past `maxStoreItems`. On ok the tool appends
the items and one submission `{submissionId:"sub-" plus 16 hex,
digest:"sha256:" plus 64 hex, itemIds, caller, submittedAt}` and
returns `{submissionId, itemIds, replayed}`. Store errors map as
`store-busy` (retryable, `{store:"work"}`), `source-unreadable`
(`work-store`), and `store-write-failed`; a lock release failure after a
committed write is a write failure, so a retry replays.

Summary on ok is `{submissionId, itemIds, replayed}`; on `dag-cycle` and
`unknown-dependency` it is `{edge}`; on `duplicate-id` it is `{id,
indices}`; on `store-full` it is `{limit}`; on the `index` codes it is
`{index}`; on `id-exists` it is `{ids}`; the step-0 `invalid-arguments`
(`maxItems`) keeps `null`. Item ids are synthetic slugs, never brief
text. The call log carries only the summary, never the arguments.

## `approve`, `pause_fleet` and `resolve_session`

`approve`, `pause_fleet` and `resolve_session` (`[sensitive: records a
request a human must confirm out of band; never executes]`) record a
`pending` approval request through `recordRequest` and return `{requestId,
state:"pending", outcome:"recorded"|"existing"}`. The `approve` description
is `[sensitive: ...] Requests a human approval to merge one pull request
at one head.`, `pause_fleet` is `[sensitive: ...] Requests a human pause
or resume of new starts.` and `resolve_session` is `[sensitive: ...]
Requests a human resolution of one stuck dispatcher session.`
`resolve_session` takes `{requestId, reason}` where `requestId` is a
dispatcher session id (`<workItemId>:<round>`) and `reason` is non-empty;
the tool records the request only and never calls the dispatcher. Every
snapshot `inputSchema` is `type: object`
with `additionalProperties: false`, `minLength: 1` on `reason` and no
`maxLength`; `validate` is compiled from it with `new Ajv({ strict: true
})` from `ajv/dist/2020` at startup. `run` loads the approvals config
first (`source-unreadable {source:"requests"}` with the message in
`detail` on failure), then refuses a `reason` longer than
`maxReasonChars` code points as `invalid-arguments` at `/reason`
(`maxLength`), retryable `false`. `approve` then checks the work store:
unknown id is `unknown-work-item` (`"unknown work item <id>"`); a status
other than `review` is `not-in-review` (`"item <id> is <status>, not
review"`); a pull mismatch is `pull-mismatch` (`"item <id> has pull
<n|null>"`). Errors map as `store-busy {store:"requests"}`
(retryable), `source-unreadable {source:"requests"}`,
`store-write-failed`, and `source-unreadable {source:"work-store"}` for
a work-store read failure on `approve`; an exception message goes only to
`detail`. Summary on ok is `{requestId, outcome}`; on a refusal or an
error it is `null`, because the call-end line already carries `code`.

## Why an MCP call alone never executes a sensitive action (A9)

1. The sensitive handlers call only `recordRequest`. That function can
   create `pending` entries only and has no parameter for `state`.
2. `decideRequest` lives in its own module, `src/approvals/decide.ts`.
   Test X4 walks `src/mcp/` recursively and collects the import specs
   of every file (each must be a `*.ts` file) with Bun's import
   scanner. Each spec is resolved with Bun's own resolver from the
   importing file's directory and taken as a real path, so symlinks
   and `package.json` or `tsconfig.json` aliases resolve as they do
   at runtime. Only `node:` and `bun:` modules and `bun` itself are
   builtins, and any other resolved module that is not a file fails
   with `import "<spec>" in <file> resolves to a non-file module`.
   A result under the repository's top-level `node_modules/` is not
   followed; anywhere else `node_modules` is an ordinary directory.
   Y8 is an early warning only: a root dependency in `dependencies`,
   `devDependencies`, `optionalDependencies` or `peerDependencies`
   whose spec starts with `file:`, `link:`, `workspace:`, `.` or `/`
   fails with `dependency "<name>" points into the file system: <spec>`.
   Dependency and install inputs
   (`package.json`, `bun.lock`, patches, files under `node_modules/`)
   are outside X4 and covered by review and by the runtime boundary
   in #94. A spec Bun cannot resolve fails with
   `unresolved import "<spec>" in <file>`. A spec that resolves
   outside the repository fails X4 with
   `import "<spec>" in <file> leaves the repository`. A spec that
   resolves to a file other than `.ts` or `.json` fails X4 with
   `import "<spec>" in <file> resolves to an unsupported file type`.
   JSON files join the closure without a scan. X4 fails if
   `src/approvals/decide.ts` or `src/approvals/cli.ts` is reachable;
   it also fails on `writeFileAtomic` in any file under `src/mcp/`,
   and in every file of the closure the loader checks run on
   comment-free code and cover `require` in any form, `createRequire`,
   `getBuiltinModule`, direct `eval`, `Worker` and imports of
   `worker_threads` or `node:worker_threads`, imports of `module` or
   `node:module` and any `import.meta` other than `.url`, `.dir`,
   `.dirname`, `.path`, `.filename` or `.main`. The existing ESLint
   rule already rejects a non-literal dynamic `import()`. X4 matches
   names spelled in source. A name or code built at runtime, such as
   a computed property read with a built string or a function
   constructor reached through `.constructor`, is outside X4; a
   runtime boundary for `mcp:serve` is tracked in #94.
3. No tool reads `/dev/tty`, and there is no MCP method that decides.

Residual gap, stated honestly. The requests file and the CLI belong to
the same OS user. A coordinator, or a worker session on the same
machine, that has a shell could write the file or drive the CLI through
a pty. The guarantee is therefore "no MCP call can do it", not "no
process of this user can do it". The `/dev/tty` prompt stops
non-interactive misuse only. This is open question Q1.

## Client `mcp:call`

`mcp:call <tool> [--file <path>] [--config <path>]` spawns
`process.execPath` with `fileURLToPath(new URL("./serve.ts", import.meta.url))`,
`--caller mcp-call` and the passed `--config` (default `config/mcp.json`), using
stdin/stdout pipes and inherited stderr. It sends `initialize`
(protocolVersion `"2025-11-25"`, clientInfo `{name:"mcp-call",version:<server>}`),
then `notifications/initialized`, then `tools/call` with arguments from `--file`
or `{}`. It prints `structuredContent` as one compact JSON line. Exit codes:
0 on `ok:true`, 3 on `ok:false`, 2 on usage or bad `--file`, 4 when the
server exits early, a JSON-RPC error returns, a response is malformed, or
no answer arrives within `clientTimeoutMs`.
