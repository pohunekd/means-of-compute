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
`callers`, load the work and dispatcher configs plus factory specs,
`requireWritableTarget` for the call log and store paths,
`requireInputDir` for the verdict dir, open the call log, append
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
initialized"`. `tools/list` answers in PR order (read slice: only
`fleet_status` so far). Unknown methods are `-32601`, unknown tools are
`-32602 "Unknown tool: <name>"`, batch arrays are `-32600 "batch not
supported"`, unparsable lines are `-32700 "parse error"`. Every JSON-RPC
error response also appends a `protocol-error` line with `jsonrpcCode`.

`config/mcp.json` (`loadMcpConfig`): `serverInfo`, `callers` (pattern
`^[a-z][a-z0-9-]{0,31}$`, unique), `callLogPath`, `maxMessageBytes`
(1024-16777216), `clientTimeoutMs` (1-600000), `workConfigPath`,
`auditorConfigPath`, `dispatcherConfigPath`. Every key is required, no
extra key is allowed. The PR 2 slice has no approvals key yet.

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
work store plus `openSessions` (registry entries with `terminal: null`).
It reads only `storePath` and `registryPath` from the work and dispatcher
configs, so an unknown provider model never fails it. Store or registry
unreadable (missing file with a missing parent, non-file path) is
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
