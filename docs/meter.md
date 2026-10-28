# Metering proxy

All model traffic from fleet sessions flows through the metering proxy
(`src/meter/`). The proxy holds the provider keys: the session receives
its caller token through session metadata, and the token is valid only
while its grant is open, and the proxy records
per-session
token usage into an append-only log. `createMeteredPort`, the `meter:usage` CLI and the host token helper exist.

## Proxy

The proxy is one HTTP listener inside the factory process, next to the
dispatcher. Fleet hosts reach it over the overlay with plain HTTP inside the
overlay tunnel. It serves exactly one route:

- `POST /v1/chat/completions`, streaming and non-streaming.
- Any other path gives 404 `not-found`. Another method on that path gives
  405 `method-not-allowed`. There is no models listing and no health route.

One call runs these steps in order; the first failure answers the caller and
nothing goes upstream:

1. Route check.
2. Call authorization (below).
3. `Content-Type` must start with `application/json`
   (case-insensitive), else 415. A `Content-Length` above `maxRequestBytes`
   gives 413.
4. Read the body as text and parse it. A failure gives 400 `invalid-json`;
   a non-object body, a non-boolean `stream`, a non-object
   `stream_options`, or a `model` other than `sessionModelId` gives 400.
   The caller never chooses the model: the proxy overwrites the body with
   the grant's provider model, and for streams it forces
   `stream_options.include_usage` to `true`.
5. The grant's provider must be routed. A grant whose provider left the
   routes gets 503 `provider-not-routed`: the status is 503 because the
   cause is the meter's own route config, not the caller. When the
   provider is routed but its key variable is empty at this moment, the
   answer is 503 `provider-key-missing`.
6. Record `call-start` through the guarded append: validation runs
   first (`checkRecord`, no write, no latch), then the write, then
   `datasync`, then the in-memory commit. A validation failure rejects
   with `MeterLogError`, logs `usage-log-rejected`, and the caller gets
   503 `meter-unavailable` with no latch. A write or `datasync` failure
   latches the meter. The guard re-checks that the meter has not
   failed, the grant is open, and the session stays under
   `maxInFlightPerSession`. The failures give 503 `meter-unavailable`,
   403 `grant-closed`, and 429 `session-concurrency`. A new call can
   therefore never follow its grant's `grant-close` in the log.
7. Forward to exactly one upstream — the grant's provider — with exactly
   these headers: `Content-Type: application/json`, an `Accept` matching
   the stream flag, and `Authorization: Bearer <provider key>` when the
   descriptor names a key variable. No caller header is forwarded. There is
   no failover and no budget check inside the proxy: a 429 or any other
   non-2xx status goes back to the caller unchanged and unbilled.
8. Pump the response to the caller — for 2xx and non-2xx alike, with
   the same timers, the same drain abort, and the same caller
   streaming — and record `call-end` before the caller's stream closes
   or errors. Counts come from the last `usage` object of the stream
   (or of the JSON body), with `prompt_tokens` as input and
   `completion_tokens` as output. A missing or unreadable usage
   gives a billed `no-usage` record with null counts — never zero.
   A count that is missing or not an integer is `null`, and the
   outcome stays `ok`.
   A non-2xx answer is always `call-end` `upstream-status`, unbilled,
   with null counts, whatever happens to the body.
9. Timeouts come only from this config, never from a provider descriptor's
   `timeoutMs`: first-byte (504, billed, null), idle gap (stream errored
   after the end, billed), and total time from `t0` (billed). The total
   timer is armed once at `t0` and never re-armed; the first-byte timer
   is cancelled at the headers; the idle timer arms at the headers and
   re-arms after each chunk. A connection failure gives 502 and is
   not billed. Every such 502/504 is covered by `call-finished`, not by
   `request-rejected`.

A caller that disconnects does not cancel the upstream read: the pump reads
upstream to its end under the same timers and discards the bytes, because
the provider has already billed the call. The disconnect itself is logged
as `caller-gone`. The `call-end` record then
carries `clientGone: true` with the observed usage. The pump order is
fixed: tap end, then `finishEnd` (the `call-end` append), then the live
registry release, then the caller stream close or error. The caller
stream is errored only through one helper, which first logs
`caller-stream-errored` and then errors the stream.

Every error the proxy itself answers with status `>= 400` logs exactly
one `request-rejected` event with the code and status, plus the
`requestId` whenever the bearer MAC already held (A1). This covers 404,
405, 401, every A2-to-A5 code, 415, 413, `invalid-json`,
`invalid-body`, `model-mismatch`, `provider-not-routed`, `provider-key-missing`, and the guard
verdicts `grant-closed`, `session-concurrency`, and `meter-unavailable`.
`call-finished` carries the `hostAlias` for the billing join.

Every error the proxy itself answers has the body
`{"error":{"type":"moc_meter","code":"<code>","message":"<code>"}}`.

### Call authorization

The predicate runs in this order; the first failing row decides:

| #   | Check                                                                                                   | Answer              |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------- |
| A1  | the `Authorization` header is exactly `Bearer <token>`, with a valid `moc1.<grant>.<mac>` shape and MAC | 401 `unauthorized`  |
| A2  | a grant exists for the token's request id                                                               | 403 `no-grant`      |
| A3  | the grant is not closed                                                                                 | 403 `grant-closed`  |
| A4  | a still-unbound grant is within `unboundGrantTtlMs` of its last opening                                 | 403 `grant-unbound` |
| A5  | the caller address is in the host map under the grant's host alias                                      | 403 `wrong-host`    |

An unauthenticated caller learns nothing about grants: rows 2 and later run
only after row 1 holds. A token is useless after the session ends, and
rotating the secret invalidates every live token. A caller token
is valid only while its grant is open, and it travels through
session metadata, never through a config file.

### Caller token

The token is per session and derived, never stored:

```
token = "moc1." + base64url(utf8(requestId)) + "." + base64url(HMAC-SHA256(K, "moc-meter-v1\n" + requestId))
```

`K` is the decoded value of the variable named by `secretEnv`. It exists
only in the factory process; hosts never hold it. The token is
deterministic, so replaying a start delivers the same token. Minting is
`meter.tokenFor(requestId)`; validity always follows the grant state, never
the token alone; revocation is the `grant-close` record.

## Config keys

`config/meter.json` holds every key below. Every key is required, no extra
key is allowed, and any failure throws `MeterConfigError` naming the key
(exit 2). There are no defaults.

| Key                                              | Rule                                                  |
| ------------------------------------------------ | ----------------------------------------------------- |
| `listenEnv`, `secretEnv`, `hostAddressesFileEnv` | match `^[A-Z][A-Z0-9_]*$`                             |
| `listenAlias`                                    | matches `^[a-z][a-z0-9-]{0,31}$`                      |
| `usageLogPath`                                   | non-empty string                                      |
| `sessionModelId`                                 | matches `^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`         |
| `maxRequestBytes`, `maxUsageScanBytes`           | integers in `1024..67108864`                          |
| `clientIdleTimeoutSec`                           | integer in `1..255`                                   |
| `firstByteTimeoutMs`, `idleTimeoutMs`            | integers in `1..600000`                               |
| `totalTimeoutMs`                                 | integer in `1..86400000`, and `>= firstByteTimeoutMs` |
| `drainTimeoutMs`                                 | integer in `0..600000`                                |
| `unboundGrantTtlMs`                              | integer in `1000..3600000`                            |
| `maxInFlightPerSession`                          | integer in `1..64`                                    |

Committed values: the listener alias is `factory`, the session model id is
`moc-session`, and the usage log is `logs/meter-usage.jsonl`.

## Env vars

The three `*Env` keys name the environment variables; the file below shows
the committed names. Every error names the variable, never its value.

- `MOC_METER_LISTEN` — value `host:port`. The host must be a numeric IP
  (`node:net`), never a wildcard or a mapped address: `0.0.0.0` is
  refused, and an IPv6 host is canonicalized with `new URL(...)` and
  refused when it is `[::]` or starts with `[::ffff:` — so
  `[::ffff:0.0.0.0]`, `[0:0:0:0:0:ffff:0.0.0.0]`, `[::0.0.0.0]`, and
  `[::ffff:127.0.0.1]` are all refused. Port `0` means ephemeral and is
  used by tests. The address is private and never committed; logs and
  errors name the listener only by the alias `factory`.
- `MOC_METER_SECRET` — strict base64 decoding to at least 32 bytes. It
  exists only in the factory process; it is never logged, never put in an
  error text, and hosts never hold it. Check presence with
  `test -n "$MOC_METER_SECRET"`; never print the value.
- `MOC_METER_HOST_ADDRESSES_FILE` — path of an uncommitted JSON file:
  `{ "<alias>": ["<ip>", ...] }`. Aliases match
  `^[a-z][a-z0-9-]{0,31}$`; every address is a numeric IP, none uses the
  `::ffff:` form, addresses are unique within an alias, and one address
  belongs to at most one alias. Example (synthetic):
  `{"laptop-a": ["127.0.0.1"]}`.

### Operator secret command

Generate the secret and store it without printing it:

```sh
( set -eu; : "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}"; install -d -m 0700 "$XDG_RUNTIME_DIR/moc"; chmod 0700 "$XDG_RUNTIME_DIR/moc"; ( umask 077 && openssl rand -base64 32 > "$XDG_RUNTIME_DIR/moc/meter-secret" ); chmod 0600 "$XDG_RUNTIME_DIR/moc/meter-secret" ) && export MOC_METER_SECRET="$(cat "$XDG_RUNTIME_DIR/moc/meter-secret")" && test -n "$MOC_METER_SECRET" && echo set
```

The file is created in a subshell with `set -eu`, so an unset `XDG_RUNTIME_DIR` stops it, also when pasted; the `&&` chain then skips the export; the export runs in the current shell. The explicit `chmod`s make the modes hold even when the directory or the
file already exists. The secret file lives outside the repository,
never under `logs/`.

## Usage-log format

The log is a dedicated append-only JSONL file at `usageLogPath`, one object
per line, validated by `src/meter/usage-log.schema.json`. File mode is
`0o600`; all appends of a meter go through one in-process chain —
`checkRecord` (validate, no write, no latch), then the write, then
`datasync`, then the in-memory commit — so the index always equals the
durable file. A validation failure rejects with `MeterLogError`
(`usage-log-rejected` at `error` level), with no write, no latch, and no
index change. A crash therefore never leaves a forwarded call without a
`call-start`; at worst it leaves a `call-start` without an end, which the
join counts as one request with null counts.

Record kinds:

```json
{"kind":"grant-open","at":"...","requestId":"w1-demo:0","workItemId":"w1-demo","hostAlias":"laptop-a","providerId":"meta-api","model":"muse-spark-1.3-contributor"}
{"kind":"grant-bind","at":"...","requestId":"w1-demo:0","sessionId":"sess-1"}
{"kind":"grant-close","at":"...","requestId":"w1-demo:0","state":"finished"}
{"kind":"call-start","at":"...","callId":"...","requestId":"w1-demo:0","providerId":"meta-api","model":"muse-spark-1.3-contributor","stream":true}
{"kind":"call-end","at":"...","callId":"...","requestId":"w1-demo:0","outcome":"ok","billed":true,"status":200,"inputTokens":9,"outputTokens":4,"clientGone":false,"ms":601,"bytesIn":81,"bytesOut":151}
```

Rules:

- `at` is the exact `toISOString()` form. `status` is an integer or
  `null` (used before headers). Counts are integers `>= 0` or `null`.
- `outcome` is one of `ok`, `no-usage`, `first-byte-timeout`,
  `idle-timeout`, `total-timeout`, `upstream-status`,
  `upstream-unreachable`, `upstream-broken`, `upstream-error`,
  `closed-abort`. The `billed` flag must match the outcome:
  `upstream-status` and `upstream-unreachable` are false, every other
  outcome is true.
- A repeated `grant-open` for one request id must equal the first one in
  `workItemId`, `hostAlias`, `providerId`, and `model`. At most one
  distinct `sessionId` per request id, and at most one request id per
  `sessionId`. `grant-close` appears at most once per request id; a
  `call-start` needs an earlier `grant-open` and no earlier `grant-close`.
  A `call-start` for a closed grant can never be appended after its
  `grant-close`.
- `callId` is unique; each `call-end` needs exactly one earlier
  `call-start` with the same `callId` and `requestId`.
- A torn tail (text not ending in `\n`) is cut at the byte boundary:
  `cut = Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1))`,
  and the dropped count is the tail's byte length. It is truncated at
  startup with a `usage-log-torn-tail` warning; a reader ignores the
  fragment. Any other violation throws `MeterLogError` naming the path
  and the 1-based line number (exit 2).
- Any append failure latches the meter to failed (`usage-log-failed`):
  new calls get 503 `meter-unavailable`, and only a restart clears the
  latch.

The join (`joinUsage`) groups billed calls of one request id by provider
and model, in first-appearance order, with null-propagating token sums and
`source: "meter-proxy"`. One billed call without usage makes that
session's counts `null`, and the budget guard refuses `spend unknown` for
a priced provider — the fail-safe, never a zero. A session with no billed
call gets a measured zero (`requests: 0`, counts `0`).

## Grant lifecycle

The factory (later the metered dispatcher port) drives each session's grant:

1. `openGrant({requestId, workItemId, hostAlias, providerId, model})` —
   pure checks (patterns, provider, model, host) run outside the chain;
   the index-dependent guard is one `appendGuarded` call. A closed grant
   gives `grant-closed`; a field differing from the first open gives
   `request-conflict`. Refused with `provider-not-routed`,
   `model-mismatch`, or `unknown-host` when the spec does not match the
   routed providers and the host map.
2. `bindGrant(requestId, sessionId)` — the guard gives `unknown-request`
   for an unknown grant, returns success with no record for
   `already-bound`, and gives `session-conflict` for another `sessionId`
   on this grant or this `sessionId` on another grant.
3. Calls flow while the grant is open. A call joins the live set inside
   its `call-start` chain step, when the guard passes and before the
   write, and leaves when its `call-end` append settles.
4. `settle(sessionId, state)` finds the grant by session and delegates to `settleRequest(requestId)`, which owns one memoized `Promise<PortUsage | null>` per request id. After the close and the drain, the join is stable through replays and repeated calls.
5. `settleRequest(requestId, state)` owns one memoized `Promise<PortUsage | null>` per request id: it finds the grant by request id (grant-close never names a session,
   so the stranded billing of a lost session survives) and joins its calls. An unbound grant (opened, never bound) closes here and
   joins its calls: the first settle step in the design. An unknown
   request id returns `null` and logs `unknown-grant`.

## Metered port

`createMeteredPort(inner, meter, log)` wraps a `DispatcherPort`. `start` opens the grant, then calls `inner.start`, then binds the grant to the session.

Open fails with `grant-closed`: the port throws `PortUnreachableError` and logs `grant-closed-on-start`. Any other grant code: `PortRejectedError` with code `meter-<code>`. `MeterUnavailableError` and errors of `inner.start` pass through unchanged.

Bind fails with `session-conflict`: `PortRejectedError` `request-conflict`, which the dispatcher turns into `DispatchStateError` `port-binding-conflict` and keeps the entry. `unknown-request`: `meter-unknown-request`; the dispatcher removes the entry and logs `start-rejected`, as for every other rejected start.

Every terminal result of `wait` and `cancel` gets `usage` from `meter.settle(sessionId)`. A non-null usage from the inner port is dropped and logged as `port-usage-ignored`. A `null` join gives `usage: null`, which the dispatcher stores as `usage-unreported`.

A latched meter rethrows `MeterUnavailableError`.

`diff` and `close` delegate to the inner port; `close` does not close the meter.

The provisional lost path runs only when `port.start` is unreachable; there `settleUsage(requestId, "lost")` gives the measured join, a zero row when no call ran. A bound session that ends lost on the watch path gets its join through the same hook. A start rejected with a grant settles through the same hook with `"failed"`.

## Lost usage

`createDispatcher` takes a required `settleUsage(requestId, state)` hook: the first step of `finishLost`, before the first registry write, reads back the durable usage through this hook. `finishLost` settles with `"lost"` and a rejected start with `"failed"`. The factory sets `settleUsage` to `meter.settleRequest`, so the meter settles before the terminal exists. An invalid row stores `null` (`usage-invalid` event, `usage-invalid` token source) instead of the fabricated counts, and the budget guard refuses unknown spend — never a measured zero.

## Usage CLI

`bun run meter:usage -- --log <path> --request <id>` prints the `joinUsage` row of one request as one JSON line (exit 0). The CLI replays the log read-only; a torn tail is ignored and the file is never modified. A request without a grant prints `meter: no grant for <id>` on stderr (exit 3). A usage error (bad flags, missing values, a repeated or unknown flag, a validation failure) or no log file prints one `meter:` line on stderr (exit 2).

## Host setup

The factory's agent profile is a pi profile with `--provider moc-meter --model moc-session`. Its env holds:

- `PI_CODING_AGENT_DIR` set to a host-local dir (for example `~/.config/means-of-compute/pi-agent/`);
- `MOC_METER_TOKEN_TIMEOUT_MS`;
- no provider key variable.

That dir holds `models.json`, shaped as `config/host-agent/pi-models.example.json`, with the real proxy URL, and a copy of `scripts/host/meter-token.mjs`. The URL and the dir are host-local and never committed.

`node` and `pohunek` must be on `PATH`.

The adapter puts the token into `session.new` metadata `moc.meterToken`. The helper reads it with `pohunek session inspect <own id> --json` and prints it, and pi sends it as `Authorization: Bearer`.

Metadata is readable by every client of that daemon. Source binding (A5) and the grant lifetime (A3) bound that exposure. A voided start clears the key.

The helper's stderr lines, each with exit 1 and empty stdout:

- `meter-token: POHUNEK_SESSION_ID is not set` or `meter-token: POHUNEK_SESSION_ID is invalid`;
- `meter-token: MOC_METER_TOKEN_TIMEOUT_MS is not set` or `meter-token: MOC_METER_TOKEN_TIMEOUT_MS is invalid`;
- `meter-token: pohunek failed to start`, `meter-token: pohunek timed out`, `meter-token: pohunek exited <code>`, or `meter-token: pohunek <signal>`;
- `meter-token: inspect output is not JSON`;
- `meter-token: no meter token in session metadata`;
- `meter-token: meter token is malformed`.

The host precondition is checked per host in W3.1.
