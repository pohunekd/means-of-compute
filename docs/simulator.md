# Fleet simulator

Headless what-if replay of the fleet over an evening window. It expands a
timeline of about 300 synthetic hosts, applies waves and explicit events
minute by minute, and records a `sim-trace-v1` JSONL trace with `simulated`
on every line. The trace is read by the live view; the simulator never
touches the live fleet.

## Timeline

File `config/sim/evening-300.json` with `schemaVersion sim-v1`.

- `seed 20261103`, `startAt 2026-11-03T17:00:00.000Z`, `durationMinutes 240`,
  `speed 60`.
- Kinds: `desk` (180), `laptop` (80), `kiosk` (12), `meeting` (20),
  `signage` (8). Each kind carries cores, memory, gpu, battery, window
  `allowedWindow`, `startsIdle`, `maxConcurrentAgents`.
- Generators in file order, each `kind`, `count`, `aliasPrefix`, `site`.
  Two `desk-` rows (90+90) continue the three-digit suffix per prefix, so
  `desk-001`..`desk-180` with no duplicates. Laptops are
  `laptop-001`..`laptop-080` on `hq-floor-2`, kiosks on `kiosk-lobby-*`,
  meeting on `meeting-3b-*`, signage on `signage-lobby-*`.
- Waves in file order: desk leave 0.5 at 10 (stagger 1), laptop leave 0.6
  at 20 (stagger 2), desk leave 0.5 at 40 (stagger 1), laptop depart 0.4 at
  35 (stagger 0.5), laptop rejoin 0.4 at 70 (stagger 1), kiosk window
  enter 1.0 at 55, meeting window enter 1.0 at 15, signage window enter
  1.0 at 18. Fraction uses `ceil(fraction * kindCount)`; stagger is
  `atMinute + i * staggerMinutes`, skipped when past duration.
- Explicit events: `laptop-007` battery 40 at 95, `desk-142` return at 100,
  `laptop-021` unplug at 130.
- Work: `firstAtMinute 12`, `everyMinutes 6`, `count 28`,
  `durationMinutes 25`, `idPrefix sim-w-`; ids are
  `sim-w-001`..`sim-w-028`.

Validation forbids unknown or missing keys at every level and validates
`alias` against `^[a-z][a-z0-9-]{0,31}$`, `HH:MM` windows, and that every
event alias exists in the expanded fleet. An extra key exits 2 naming the
field, for example `events[0]: unexpected key "extraKey"`.

## Fleet expansion

Initial `HostCapacity` per host:

- `cpu.load1m` drawn from `0.2..2.4`, `memory.freeMb` from `40%..75%` of
  `memoryTotalMb`, both via `mulberry32(seed)` in generator file order,
  per host alias order.
- `batteryPercent` 100 for laptops otherwise `null`, `acPower true`,
  `idle` from `startsIdle`, `secondsSinceInput` 1800 when idle else 0,
  `insideWindow` derived from `startAt` UTC minute against
  `allowedWindow` (`start === end` means always inside; otherwise
  wrap-around checked like `src/probe/idle-rule.ts`).

## Waves and events

Waves expand deterministically after the generator draws have consumed the
PRNG. For each distinct kind in first-appearance order a single shuffle of
the sorted alias list is performed with the same `mulberry32` instance.
For that kind a pointer tracks the next unused host; `leave` and
`window-enter` take the next `ceil(fraction*count)` hosts, `depart` takes
the next chunk and remembers it as the depart set, `rejoin` reuses the
depart set so the same laptops that left the site network later rejoin.
If a pointer would exceed the kind size the selection wraps from the start;
this keeps the desk story (two 0.5 leaves cover all 180 desks) and the
laptop story (60% leave then 40% depart cover all 80, rejoin brings the
same 40% back). Kiosk, meeting and signage stay at zero stagger for
1.0 fractions.

Laptop waves use the sorted alias order rather than shuffle so
`laptop-007` is in the 0.6 leave set and shows the battery floor at 95
while remaining eligible until the battery drop; this is an open choice
documented below.

Each selected alias becomes a timed event `{atMinute, alias, type, set?}`
with `acPower: true` for `rejoin` where applicable. Explicit events are
appended after waves; for the same minute waves emit before explicit
events, both in file order.

State patch per event type:

- `leave` idle true, `secondsSinceInput 1800`.
- `return` idle false, `secondsSinceInput 0` (makes `desk-142` ineligible
  at 100 with `not idle` reason).
- `depart` offline true.
- `rejoin` offline false, `acPower` from `set`.
- `window-enter` insideWindow true, and for `kiosk` also idle true with
  120 minute idle reason.
- `window-exit` insideWindow false and idle false.
- `battery` sets `batteryPercent`.
- `unplug`/`plug-in` toggle `acPower`.

Every state update validates through `isHostCapacity`; an invalid
capacity throws.

## Engine loop

Minutes `0..durationMinutes` inclusive. The header line is emitted first,
then the sorted initial host lines at minute 0. For each minute:

(a) apply all waves+events at that minute in file order, emitting an
`event` line per entry; (b) close work whose `endMinute == atMinute`
emitting `work-end`; (c) if any host changed or work ended, call
`place(probe, onlineHosts, running, config)` once and refresh eligibility
for every host from the probe decision's candidates (offline stays
`offline`); (d) enqueue work arriving at this minute, then drain the
queue FIFO, calling `place(item, onlineHosts, running, config)` per queued
item in arrival order, emitting `placement` with `eligibleCount` and the full
`candidates` array, and immediately adding a chosen item to `running` with
`endMinute = atMinute + work.durationMinutes` (so the host's next placement
in the same minute sees the running work). A chosen host's agent count
increments; the `maxConcurrentAgents` exclusion appears as
`at agent limit (2/2)` or `(1/1)`.

Host state priority for the trace `host` line: `offline` > `busy` (idle
false) > `running` (runningCount>0) > `eligible` > `blocked`; `eligible`
and `excludeReason` come from the probe decision, `running` counts live
`running` entries, `maxAgents` and `batteryPercent` reflect the HostCapacity.

Eligibility uses the real `place()` from `src/placement/place.ts` with the
real `config/placement.json` (`batteryFloorPercent 50`,
`minInputIdleSeconds 900`, `weights 0.4/0.4/0.2`); the simulator never
re-implements scoring and respects the battery floor, idle floor, AC and
window rules exactly as the live placement.

## Trace format `sim-trace-v1`

JSONL, one JSON object per line, every line has `simulated: true`.

- `header` once: `schemaVersion`, `timeline`, `seed`, `startAt`, `speed`,
  `durationMinutes`, `hostCount`, `kinds[]` sorted by kind, `simulated`.
- `host` per changed host (plus all 300 at minute 0): `atMinute`, `at`
  ISO, `alias`, `hostKind`, `site`, `state`, `eligible`, `excludeReason`
  (or null), `running`, `maxAgents`, `batteryPercent`.
- `event` per wave and explicit event: `atMinute`, `at`, `alias`, `event`,
  `text` (human readable, e.g. battery at 40 percent), `simulated`.
- `placement` per work arrival (28): `atMinute`, `at`, `workItemId`,
  `chosenHostAlias` or null, `reason` (chosen host reason or null
  reason when unplaced), `eligibleCount`, `candidates` (full placement
  decision, sorted by hostAlias, with `score`, `reason`, `excluded`).
- `work-end` per finished work (28): `atMinute`, `at`, `workItemId`,
  `hostAlias`.
- `summary` once: `placements`, `chosen`, `unplaced`, `workEnds`,
  `hostChanges` (initial 300 plus every host line emitted for changes),
  `simulated`.

All timestamps are derived from `startAt` plus `atMinute` minutes in UTC;
`at` is `toISOString()`.

## Run

```sh
bun run sim:fleet --timeline config/sim/evening-300.json --out traces/evening.jsonl
```

- Flags `--timeline` and `--out` are required, each exactly once; an
  unknown or missing flag exits 2.
- `statInputPath` and `readInputText` validate the timeline path (absent
  vs parent errors, not a regular file).
- The simulator reads only the timeline and `config/placement.json`; it
  writes only `--out` via `writeFileAtomic`. It never reads the ledger,
  meter, registry or state and never writes any other file.
- The CLI exits 0 on success after printing
  `sim: 300 hosts, 626 host changes, 28 placements (28 chosen, 0 unplaced) -> <out>`
  counting `host` lines as host changes; a validation error exits 2.
- Two runs with the same seed and timeline produce byte-identical JSONL.

## Invariants

- Determinism: `mulberry32` with draws consumed in generator order then
  per-kind shuffles; every collection sorted before iteration.
- Real placement: every eligibility refresh and every queue placement calls
  `place()`; the trace `reason` and `score` are the live reasons.
- No silent defaults: timeline validation has no defaults, every required
  key checked, extra keys rejected.
- Battery floor: `laptop-007` at 95 drops to 40 and is excluded with
  `battery at 40 percent, at or below the 50 percent floor` in both its
  host line and the placement 96 candidate; `desk-142` at 100 returns and
  its host line is `busy` with `not idle`.
- No side files: `src/sim/*` imports only placement, contracts, fs/input
  for validation, and fs/write for `--out`; tests assert the file list
  and source imports contain none of `ledger`, `meter`, `registry`.

## Design vs reality

Authoritative design is issue #284 first comment decisions 1-8 and body A.
All of A is implemented: timeline, fleet expansion, waves, events, work,
engine and trace. None of B (live view) is in this change. Open choices:

- PRNG per-kind shuffle with pointer and depart set reuse to keep
  depart/rejoin correlation and guarantee the two desk leaves cover all
  desks and laptop depart/rejoin are the same 32 hosts.
- Laptop waves use sorted order not shuffle so the documented battery
  story (`laptop-007` in the 60% leave set) is hit regardless of shuffle
  randomness; other kinds use shuffled order.
- Inside-window derivation uses UTC minute comparison with wrap-around,
  matching `src/probe/idle-rule.ts`.
- `host` line `state` mapping uses offline > busy > running > eligible >
  blocked and `running` counts live running entries; `maxAgents` from
  kind, `batteryPercent` from HostCapacity.
- `unplug`/`plug-in` and `window-exit` mutate `acPower`/`insideWindow` as
  described; they are not exercised by the evening timeline but are
  validated and handled.
