# Approvals

Out-of-band confirmation for sensitive actions. A sensitive MCP call only
records a `pending` request; a human operator later approves or rejects it
with the `approvals` CLI. No MCP method decides, and no code under
`src/mcp/` names the decide module or the atomic writer.

## Files

- `config/approvals.json`: `requestsPath`, `operators`, `maxPendingRequests`,
  `maxReasonChars`. Every key is required and no other key is allowed.
- `src/approvals/requests.schema.json`: validates the requests file. The
  `approve` args are `workItemId`, `pullNumber`, `headSha` and `reason`; the
  `pause_fleet` args are `action` (`pause` or `resume`) and `reason`. `reason`
  has no `maxLength` in the file; `maxReasonChars` limits new requests only.
- `src/approvals/store.ts`: request types, `checkApprovals`, `readApprovals`,
  `recordRequest`, `fleetPause`, `pendingRequests`, `approvedMerge`.
- `src/approvals/decide.ts`: `decideRequest` moves one pending request to
  `approved` or `rejected` under the requests lock.
- `src/approvals/cli.ts`: `list` and `decide`; `runApprovalsCli` takes
  `confirm`, `now`, `out` and `err`, so tests inject `confirm` and only `main`
  opens `/dev/tty`.

## Requests file (A1)

`requestsPath` holds one JSON document: `{schemaVersion:"v1", nextSeq,
requests}`. `requestId` is `"req-" + String(seq).padStart(6,"0")`. `state`
is `pending` exactly when `decision` is `null`. `args` matches its tool's
input schema. Every request `seq` and decision `seq` is unique and below
`nextSeq`. `checkApprovals` throws `ApprovalsDataError` on any breach. An
absent file with an existing parent is `{schemaVersion:"v1", nextSeq:1,
requests:[]}`. Writes use `withFileLock("requests lock", requestsPath, ...)`
plus `writeFileAtomic`. A held lock is `ApprovalsBusyError`; a failed write
is `ApprovalsWriteError`.

## Recording (A2)

`recordRequest(path, {tool, args, caller, now, maxPending})` runs under the
lock and returns `{kind:"recorded"|"existing", request} | {kind:"refused",
code, message}`:

1. A pending request with the same `tool` and
   `argsSha256 = sha256Hex(canonicalJson(args))` exists: return `existing`.
2. `tool === "pause_fleet"` and `fleetPause(doc).paused === (args.action ===
"pause")`: return `no-change`, message `"fleet is already
<paused|running>"`.
3. The pending count is at least `maxPending`: return `too-many-pending`,
   message `"<n> requests already pending"`.
4. Otherwise append `{seq: nextSeq, state:"pending", decision:null}`, then
   `nextSeq + 1`.

## Pause state (A5)

`fleetPause(doc)` takes the `pause_fleet` request with `state ===
"approved"` and the highest `decision.seq`: `{paused:
thatRequest.args.action === "pause", pausedBy: paused ? {requestId, author,
decidedAt} : null}`; with no such request, `{paused:false,
pausedBy:null}`. Pausing stops new starts only. Running sessions continue,
and intake continues.

## Approval consumption (A6)

`approvedMerge(doc, workItemId, pullNumber, headSha)` returns the `approve`
request whose state is `approved` and whose `args` match all three, else
`null`. An approval of an older head can never merge a newer one.

## Out-of-band confirmation (A7)

- `bun run approvals:list [--config <path>]` prints one JSON line per
  pending request: `{requestId, tool, args, caller, requestedAt}`. The
  human's terminal shows the reason here and in the `decide` prompt below,
  and nowhere else: the reason never appears in an MCP result. Exit 0.
- `bun run approvals:decide <requestId> (--approve|--reject) --author
<handle> [--config <path>]`: exactly one of `--approve` and `--reject`
  is required; `--author` must be in `operators`; the request must exist;
  the request prints to `/dev/tty`, then one line is read from `/dev/tty`
  after the prompt `Type <requestId> to <approve|reject>: `. Without a
  controlling terminal the command fails. The typed line must equal
  `requestId`, then `decideRequest` runs and stdout carries
  `{requestId, state, author, decidedAt}`.
- `decideRequest(path, {requestId, decision, author, now})`: unknown id is
  `refused unknown-request`; an already decided request with the same state
  and author is `unchanged`, otherwise `refused already-decided`; a
  pending request becomes `decided` with `decision {seq: nextSeq, author,
decidedAt}`, then `nextSeq + 1`.
- Exit codes: 0 decided or unchanged; 2 for usage, config, `/dev/tty`
  unavailable, EOF at the prompt
  (`approvals: confirmation for "<id>" was not entered`,
  `src/approvals/cli.ts:147-148`), unknown request, a data error or a
  write failure; 3 for a mismatched confirmation, an already-decided
  request, or a busy lock.

## What "author" is (A8)

The operator handle given with `--author` and checked against `operators`
in `config/approvals.json` (committed `["owner"]`). It records who decided.
It is an identity label, not authentication. `caller` is the launcher-set
`--caller` of the MCP server that recorded the request. The `clientInfo`
from `initialize` is logged as `client` and never used as authority.
