# Fleet simulator

Headless what-if replay of the fleet over an evening window. It expands a timeline of 100 synthetic hosts, applies waves and explicit events minute by minute, and records a `sim-trace-v1` JSONL trace with `simulated` on every line. The trace is read by the live view; the simulator never touches the live fleet.

## Honesty rule

Simulated output never enters a real figure. The trace is the only simulated output; it lives in gitignored `logs/sim/` and is never committed. No simulated host, work item, token count or placement ever feeds the ledger, Savings, Usage, `demo:numbers` or `providerCoverageOf`/`tokenCoverageOf`. Readers must check `simulated:true` on every trace line; a missing or false marker is a bug.

## Timeline

File `config/sim/evening-100.json` with `schemaVersion sim-v1`.

- `seed 20261103`, `startAt 2026-11-03T17:00:00.000Z`, `durationMinutes 240`, `speed 60`.
- Kinds: `desk` (60), `laptop` (24), `kiosk` (6), `meeting` (6), `signage` (4). Each kind carries cores, memory, gpu, battery, window `allowedWindow`, `startsIdle`, `maxConcurrentAgents`.
- Generators in file order, each `kind`, `count`, `aliasPrefix`, `site`. Two `desk-` rows (30+30) continue the three-digit suffix per prefix, so `desk-001`..`desk-060` with no duplicates. Laptops are `laptop-001`..`laptop-024` on `hq-floor-2`, kiosks on `kiosk-lobby-*`, meeting on `meeting-3b-*`, signage on `signage-lobby-*`.
- Waves in file order: desk leave 0.5 at 10 stagger 1, desk leave 0.5 at 40 stagger 1; laptop leave 0.55 at 20 stagger 1, laptop depart 0.4 at 35 stagger 1, laptop rejoin 0.4 at 70 stagger 2; kiosk window-enter 1.0 at 120 stagger 0; meeting window-enter 1.0 at 15 stagger 0. Fraction uses `ceil(fraction * kindCount)`; stagger is `atMinute + i * staggerMinutes`, and a wave that would run past `durationMinutes` or wrap and re-select hosts exits 2.
- Explicit events: `laptop-007` rejoin at 94, leave at 94, battery 40 at 95; `desk-058` return at 100; `laptop-021` rejoin and leave at 134, unplug at 135. The rejoin+leave pair pins `laptop-007` and `laptop-021` online and idle whichever wave set they landed in.
- Work is an array of burst blocks, each with `firstAtMinute`, `everyMinutes`, `count`, `durationMinutes`, `idPrefix` and `tasks`, a non-empty array of `{ kind, title }` where `kind` is one of `code`, `research`, `data-analysis`, `report`, `support`, `translation`, `document` and `title` is 1..60 chars without control characters (C0, DEL and C1) with `{n}` at most once substituted to the zero-padded item number; when `title` contains `{n}` the substituted length must still be 1..60; `idPrefix` must be unique (duplicate exits 2 naming `work`), a single object is invalid. Each item `n` (1-based, the zero-padded suffix of `workItemId`) takes `tasks[(n - 1) % tasks.length]` and keeps its own block's `durationMinutes` and derived `task`. Committed value: `sim-w-` 15/2/10/50 code/support/research/support, `sim-x-` 50/1/35/120 research/code/research/support, `sim-y-` 65/1/35/120 data-analysis/code/data-analysis/support, `sim-z-` 80/1/30/120 data-analysis/code/support/data-analysis with 4-item cycles (see `config/sim/evening-100.json`, 110 items total). The engine merges all blocks into one schedule sorted by `atMinute`.

Validation forbids unknown or missing keys at every level and validates `alias` against `^[a-z][a-z0-9-]{0,31}$`, `HH:MM` windows, `kind` via `Object.hasOwn`, and that every event alias exists in the expanded fleet. A wave of type `battery` exits 2 naming `waves[i].type`, a `battery`/`unplug`/`plug-in` event on a `battery:none` kind exits 2, and an extra key exits 2 naming the field.

## Fleet expansion

Initial `HostCapacity` per host:

- `cpu.load1m` in [0.2,2.4], `memory.freeMb` in [40%,75%] of total, both via `mulberry32(seed)` in generator file order, per host alias order.
- `batteryPercent` 100 for laptops otherwise `null`, `acPower true`, `idle` from `startsIdle`, `secondsSinceInput` 1800 when idle else 0, `insideWindow` derived from `startAt` UTC minute against `allowedWindow` (`start === end` means always inside; otherwise wrap-around checked like `src/probe/idle-rule.ts`).

## Waves and events

Waves expand deterministically after the generator draws have consumed the PRNG. For each distinct kind in first-appearance order a single shuffle of the sorted alias list is performed with the same `mulberry32` instance. For that kind a pointer tracks the next unused host; `leave` and `window-enter` take the next `ceil(fraction*count)` hosts, `depart` takes the next chunk and remembers it as the depart set, `rejoin` reuses the depart set. The selection never wraps; a wrapping fraction exits 2 at load.

Each selected alias becomes a timed event `{atMinute, alias, type, set?}` with `acPower: true` for `rejoin`. Explicit events are appended after waves; for the same minute waves emit before explicit events, both in file order. A `battery` wave is invalid; a `battery` event requires `batteryPercent`.

State patch per event type:

- `leave` idle true, `secondsSinceInput 1800`.
- `return` idle false, `secondsSinceInput 0`.
- `depart` offline true.
- `rejoin` offline false, `acPower` from `set`.
- `window-enter` insideWindow true, and for `kiosk` also idle true with 120 minute idle reason.
- `window-exit` insideWindow false and idle false.
- `battery` sets `batteryPercent`.
- `unplug`/`plug-in` toggle `acPower`.

Every state update validates through `isHostCapacity`.

## Engine loop

Minutes `0..durationMinutes` inclusive. The header line is emitted first, then the sorted initial host lines at minute 0. For each minute: (a) apply waves+events; (b) close work whose `endMinute == atMinute` emitting `work-end`; (c) if any host changed or work ended, refresh eligibility via `place(probe)`; (d) enqueue arriving work and drain the queue FIFO calling `place(item)` per item, emitting `placement` with `eligibleCount` and the verbatim `place()` candidates and `reason`, immediately adding chosen items to `running`. After the refresh, one `host` line is emitted (deduplicated) for each host that took a placement or ended work that minute, in addition to event-driven host lines, and counted in `hostChanges`.

Host state priority: `offline` > `busy` > `running` > `eligible` > `blocked`; `eligible` and `excludeReason` come from the probe decision, `running` counts live running entries.

Eligibility uses the real `place()` with `config/placement.json`.

## Trace format `sim-trace-v1`

JSONL, one JSON object per line, every line has `simulated: true`.

- `header` once: `schemaVersion`, `timeline`, `seed`, `startAt`, `speed`, `durationMinutes`, `hostCount`, `kinds[]` sorted by kind.
- `host` per initial host plus per changed host (events, placements and work-ends): `atMinute`, `at` ISO, `alias`, `hostKind`, `site`, `state`, `eligible`, `excludeReason`, `running`, `maxAgents`, `batteryPercent`, `task` (null or `{ kind, title }` with `{n}` substituted, for a running host the earliest running item's task).
- `event` per wave and explicit event: `atMinute`, `at`, `alias`, `event`, `text`, `simulated`.
- `placement` per `place()` call (110): `atMinute`, `at`, `workItemId`, `chosenHostAlias` or null, `reason` always the verbatim `place()` reason, `task` (null or `{ kind, title }` with `{n}` substituted), `eligibleCount`, `candidates` with `score`, `reason`, `excluded`.
- `work-end` per finished work.
- `summary` once: `placements`, `chosen`, `unplaced`, `workEnds`, `hostChanges`, `simulated`.

## Run

```sh
mkdir -p logs/sim
bun run sim:fleet --timeline config/sim/evening-100.json --out logs/sim/evening-100.jsonl
```

- Flags `--timeline` and `--out` are required, each exactly once; an unknown or missing flag exits 2.
- `statInputPath` and `readInputText` validate the timeline path. `--out` refuses to overwrite an existing file unless its first line is a `sim-trace-v1` header; otherwise it exits 2 naming the path.
- The simulator reads only the timeline and `config/placement.json`; it writes only `--out` via `writeFileAtomic`. It never reads the ledger, meter, registry or state.
- On success it prints `sim: 100 hosts, <hostChanges> host changes, 110 placements (110 chosen, 0 unplaced) -> <out>` counting `host` lines. A validation error exits 2.
- Two runs with the same seed produce byte-identical JSONL.

## Invariants

- Determinism: `mulberry32` with draws in generator order then per-kind shuffles; every collection sorted before iteration.
- Real placement: every refresh and queue placement calls `place()`; trace reasons are live reasons.
- No silent defaults: every required key checked, extra keys rejected, single work object rejected.
- `config/sim/evening-100.json` `work`/`events` follow the work-volume decision on #284.

## Design vs reality

Authoritative design is issue #284 first comment decisions 1-8 and body A. All of A is implemented: timeline, fleet expansion, waves, events, work, engine and trace. None of B (live view) is in this change. PRNG per-kind shuffle with pointer and depart set reuse keeps depart/rejoin correlation.
