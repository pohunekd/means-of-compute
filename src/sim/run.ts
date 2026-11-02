/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
// Fleet simulator engine. Calls the real placement, never re-implements scoring.
import { isHostCapacity } from "../../contracts/v1/validate.js";
import type { HostCapacity, WorkItem } from "../../contracts/v1/types.js";
import { place } from "../placement/place.js";
import type { PlacementConfig } from "../placement/config.js";
import type { Timeline } from "./timeline.js";

export interface HostState {
  readonly hostCapacity: HostCapacity;
  readonly offline: boolean;
  readonly hostKind: string;
  readonly site: string;
}

interface RunningEntry {
  readonly workItem: WorkItem;
  readonly hostAlias: string;
  readonly endMinute: number;
}

interface Eligibility {
  readonly eligible: boolean;
  readonly excludeReason: string | null;
}

export interface TraceHeader {
  readonly kind: "header";
  readonly schemaVersion: "sim-trace-v1";
  readonly timeline: string;
  readonly seed: number;
  readonly startAt: string;
  readonly speed: number;
  readonly durationMinutes: number;
  readonly hostCount: number;
  readonly kinds: readonly { readonly kind: string; readonly count: number }[];
  readonly simulated: true;
}

export interface TraceHost {
  readonly kind: "host";
  readonly atMinute: number;
  readonly at: string;
  readonly alias: string;
  readonly hostKind: string;
  readonly site: string;
  readonly state: "offline" | "busy" | "blocked" | "eligible" | "running";
  readonly eligible: boolean;
  readonly excludeReason: string | null;
  readonly running: number;
  readonly maxAgents: number;
  readonly batteryPercent: number | null;
  readonly simulated: true;
}

export interface TraceEvent {
  readonly kind: "event";
  readonly atMinute: number;
  readonly at: string;
  readonly alias: string;
  readonly event: string;
  readonly text: string;
  readonly simulated: true;
}

export interface TracePlacement {
  readonly kind: "placement";
  readonly atMinute: number;
  readonly at: string;
  readonly workItemId: string;
  readonly chosenHostAlias: string | null;
  readonly reason: string;
  readonly eligibleCount: number;
  readonly candidates: readonly {
    readonly hostAlias: string;
    readonly score: number;
    readonly reason: string;
    readonly excluded: boolean;
  }[];
  readonly simulated: true;
}

export interface TraceWorkEnd {
  readonly kind: "work-end";
  readonly atMinute: number;
  readonly at: string;
  readonly workItemId: string;
  readonly hostAlias: string;
  readonly simulated: true;
}

export interface TraceSummary {
  readonly kind: "summary";
  readonly placements: number;
  readonly chosen: number;
  readonly unplaced: number;
  readonly workEnds: number;
  readonly hostChanges: number;
  readonly simulated: true;
}

export type TraceLine =
  TraceHeader | TraceHost | TraceEvent | TracePlacement | TraceWorkEnd | TraceSummary;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoAtMinute(startAt: string, atMinute: number): string {
  const startMs = new Date(startAt).getTime();
  return new Date(startMs + atMinute * 60_000).toISOString();
}

function createProbeItem(): WorkItem {
  return {
    schemaVersion: "v1",
    id: "sim-probe",
    repo: "simulated/fleet-what-if",
    title: "Probe for eligibility",
    goal: "Probe placement to read candidate eligibility",
    issue: null,
    dod: [],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
  };
}

function createWorkItem(id: string, hostAlias: string): WorkItem {
  return {
    schemaVersion: "v1",
    id,
    repo: "simulated/fleet-what-if",
    title: `Simulated work ${id}`,
    goal: "Simulated fleet work item",
    issue: null,
    dod: [],
    dependencies: [],
    status: "running",
    statusReason: null,
    assignedHostAlias: hostAlias,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
  };
}

function createQueuedWorkItem(id: string): WorkItem {
  return {
    schemaVersion: "v1",
    id,
    repo: "simulated/fleet-what-if",
    title: `Simulated work ${id}`,
    goal: "Simulated fleet work item",
    issue: null,
    dod: [],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
  };
}

function eventText(alias: string, type: string, set: Record<string, unknown> | undefined): string {
  switch (type) {
    case "leave":
      return `${alias} became idle`;
    case "return":
      return `${alias} returned`;
    case "depart":
      return `${alias} left the site network`;
    case "rejoin":
      return `${alias} rejoined the site network`;
    case "window-enter":
      return `${alias} window entered`;
    case "window-exit":
      return `${alias} window exited`;
    case "battery": {
      const bp = set?.["batteryPercent"];
      if (typeof bp !== "number") {
        throw new Error(`battery event for ${alias}: missing batteryPercent`);
      }
      return `${alias} battery at ${String(bp)} percent`;
    }
    case "unplug":
      return `${alias} unplugged`;
    case "plug-in":
      return `${alias} plugged in`;
    default:
      return `${alias} ${type}`;
  }
}

function expandGenerators(timeline: Timeline): Map<string, HostState> {
  const rng = mulberry32(timeline.seed);
  const hosts = new Map<string, HostState>();
  const prefixCounts = new Map<string, number>();
  // Draw per generator row in file order, per host in alias order: cpu.load1m [0.2,2.4], memory.freeMb [40%,75%]
  for (const gen of timeline.generators) {
    const kindDef = timeline.kinds[gen.kind];
    if (kindDef === undefined) {
      throw new Error(`Unknown kind ${gen.kind}`);
    }
    const start = prefixCounts.get(gen.aliasPrefix) ?? 1;
    for (let n = 0; n < gen.count; n += 1) {
      const suffix = String(start + n).padStart(3, "0");
      const alias = `${gen.aliasPrefix}${suffix}`;
      const cpuLoad = 0.2 + rng() * 2.2;
      const memFreeRatio = 0.4 + rng() * 0.35;
      const freeMb = Math.floor(kindDef.memoryTotalMb * memFreeRatio);
      const batteryPercent = kindDef.battery === "laptop" ? 100 : null;
      const idle = kindDef.startsIdle;
      const host: HostCapacity = {
        schemaVersion: "v1",
        hostAlias: alias,
        timestamp: timeline.startAt,
        idle,
        idleReason: idle ? "no user input for 30 minutes, on AC power" : "user input 0 seconds ago",
        secondsSinceInput: idle ? 1800 : 0,
        acPower: true,
        batteryPercent,
        cpu: { cores: kindDef.cores, load1m: cpuLoad },
        memory: { totalMb: kindDef.memoryTotalMb, freeMb },
        gpu: { present: kindDef.gpuPresent, name: null, freeMb: null },
        localModels: { reachable: false, models: [] },
        policy: {
          allowedWindow: { start: kindDef.allowedWindow.start, end: kindDef.allowedWindow.end },
          insideWindow: kindDef.initialInsideWindow,
          maxConcurrentAgents: kindDef.maxConcurrentAgents,
        },
      };
      if (!isHostCapacity(host)) {
        throw new Error(`Initial host ${alias}: invalid HostCapacity`);
      }
      hosts.set(alias, {
        hostCapacity: host,
        offline: false,
        hostKind: gen.kind,
        site: gen.site,
      });
    }
    prefixCounts.set(gen.aliasPrefix, start + gen.count);
  }
  return hosts;
}

function shuffleInPlace(arr: string[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    const other = arr[j];
    if (tmp !== undefined && other !== undefined) {
      arr[i] = other;
      arr[j] = tmp;
    }
  }
}

function expandWaves(
  timeline: Timeline,
  hosts: Map<string, HostState>,
): { atMinute: number; alias: string; type: string; set?: Record<string, unknown> }[] {
  const singleRng = mulberry32(timeline.seed);
  for (const gen of timeline.generators) {
    for (let n = 0; n < gen.count; n += 1) {
      singleRng();
      singleRng();
    }
  }
  const waveEvents: {
    atMinute: number;
    alias: string;
    type: string;
    set?: Record<string, unknown>;
  }[] = [];
  const kindAliases = new Map<string, string[]>();
  for (const [alias, state] of hosts) {
    const arr = kindAliases.get(state.hostKind) ?? [];
    arr.push(alias);
    kindAliases.set(state.hostKind, arr);
  }
  for (const aliasList of kindAliases.values()) {
    aliasList.sort();
  }
  const shuffledByKind = new Map<string, string[]>();
  const pointerByKind = new Map<string, number>();
  const lastDepartByKind = new Map<string, string[]>();
  const seenKinds = new Set<string>();
  for (const wave of timeline.waves) {
    if (seenKinds.has(wave.kind)) {
      continue;
    }
    seenKinds.add(wave.kind);
    const aliases = kindAliases.get(wave.kind);
    if (aliases === undefined) {
      continue;
    }
    const shuffled = [...aliases];
    shuffleInPlace(shuffled, singleRng);
    shuffledByKind.set(wave.kind, shuffled);
    pointerByKind.set(wave.kind, 0);
  }
  for (const wave of timeline.waves) {
    const shuffled = shuffledByKind.get(wave.kind);
    if (shuffled === undefined) {
      continue;
    }
    const count = Math.ceil(wave.fraction * shuffled.length);
    let selected: string[];
    if (wave.type === "rejoin") {
      const departHosts = lastDepartByKind.get(wave.kind);
      if (departHosts !== undefined) {
        selected = departHosts;
      } else {
        const pointer = pointerByKind.get(wave.kind) ?? 0;
        selected = shuffled.slice(pointer, pointer + count);
        pointerByKind.set(wave.kind, pointer + count);
      }
    } else if (wave.type === "depart") {
      const pointer = pointerByKind.get(wave.kind) ?? 0;
      selected = shuffled.slice(pointer, pointer + count);
      pointerByKind.set(wave.kind, pointer + count);
      lastDepartByKind.set(wave.kind, selected);
    } else {
      const pointer = pointerByKind.get(wave.kind) ?? 0;
      if (pointer + count <= shuffled.length) {
        selected = shuffled.slice(pointer, pointer + count);
        pointerByKind.set(wave.kind, pointer + count);
      } else {
        selected = shuffled.slice(pointer);
        if (selected.length < count) {
          selected = selected.concat(shuffled.slice(0, count - selected.length));
        }
        pointerByKind.set(wave.kind, (pointer + count) % shuffled.length);
      }
    }
    for (let i = 0; i < selected.length; i += 1) {
      const alias = selected[i];
      if (alias === undefined) {
        continue;
      }
      const atMinute = wave.atMinute + i * wave.staggerMinutes;
      if (atMinute > timeline.durationMinutes) {
        continue;
      }
      let set: Record<string, unknown> | undefined;
      if (wave.type === "rejoin") {
        set = { acPower: true };
      }
      waveEvents.push({ atMinute, alias, type: wave.type, set });
    }
  }
  return waveEvents;
}

function refreshEligibility(
  hostMap: Map<string, HostState>,
  running: readonly WorkItem[],
  config: PlacementConfig,
): Map<string, Eligibility> {
  const onlineHosts: HostCapacity[] = [];
  for (const state of hostMap.values()) {
    if (!state.offline) {
      onlineHosts.push(state.hostCapacity);
    }
  }
  onlineHosts.sort((a, b) => (a.hostAlias < b.hostAlias ? -1 : a.hostAlias > b.hostAlias ? 1 : 0));
  const probe = createProbeItem();
  const decision = place(probe, onlineHosts, running, config);
  const byAlias = new Map<string, { excluded: boolean; reason: string }>();
  for (const cand of decision.candidates) {
    byAlias.set(cand.hostAlias, { excluded: cand.excluded, reason: cand.reason });
  }
  const elig = new Map<string, Eligibility>();
  for (const [alias, state] of hostMap) {
    if (state.offline) {
      elig.set(alias, { eligible: false, excludeReason: "offline" });
    } else {
      const cand = byAlias.get(alias);
      if (cand === undefined) {
        elig.set(alias, { eligible: false, excludeReason: "offline" });
      } else {
        elig.set(alias, {
          eligible: !cand.excluded,
          excludeReason: cand.excluded ? cand.reason : null,
        });
      }
    }
  }
  return elig;
}

function countRunningForHost(running: readonly RunningEntry[], alias: string): number {
  let c = 0;
  for (const r of running) {
    if (r.hostAlias === alias) {
      c += 1;
    }
  }
  return c;
}

function computeState(
  hostCapacity: HostCapacity,
  offline: boolean,
  runningCount: number,
  eligibility: Eligibility,
): TraceHost["state"] {
  if (offline) {
    return "offline";
  }
  if (!hostCapacity.idle) {
    return "busy";
  }
  if (runningCount > 0) {
    return "running";
  }
  if (eligibility.eligible) {
    return "eligible";
  }
  return "blocked";
}

export interface RunOptions {
  readonly timeline: Timeline;
  readonly config: PlacementConfig;
}

export function runTimeline(options: RunOptions): TraceLine[] {
  const { timeline, config } = options;
  const hostMap = expandGenerators(timeline);
  const waveEvents = expandWaves(timeline, hostMap);
  const allEvents: {
    atMinute: number;
    alias: string;
    type: string;
    set?: Record<string, unknown>;
  }[] = [];
  for (const we of waveEvents) {
    allEvents.push(we);
  }
  for (const ev of timeline.events) {
    allEvents.push({
      atMinute: ev.atMinute,
      alias: ev.alias,
      type: ev.type,
      set: ev.set as Record<string, unknown> | undefined,
    });
  }
  const eventsByMinute = new Map<number, typeof allEvents>();
  for (const ev of allEvents) {
    const list = eventsByMinute.get(ev.atMinute) ?? [];
    list.push(ev);
    eventsByMinute.set(ev.atMinute, list);
  }

  const lines: TraceLine[] = [];
  const kindCounts = new Map<string, number>();
  for (const state of hostMap.values()) {
    kindCounts.set(state.hostKind, (kindCounts.get(state.hostKind) ?? 0) + 1);
  }
  const kindsArray = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));
  lines.push({
    kind: "header",
    schemaVersion: "sim-trace-v1",
    timeline: timeline.name,
    seed: timeline.seed,
    startAt: timeline.startAt,
    speed: timeline.speed,
    durationMinutes: timeline.durationMinutes,
    hostCount: hostMap.size,
    kinds: kindsArray,
    simulated: true,
  });

  const workDurationById = new Map<string, number>();
  const workSchedule: { atMinute: number; id: string }[] = [];
  for (const block of timeline.work) {
    for (let n = 0; n < block.count; n += 1) {
      const atMinute = block.firstAtMinute + n * block.everyMinutes;
      if (atMinute <= timeline.durationMinutes) {
        const id = `${block.idPrefix}${String(n + 1).padStart(3, "0")}`;
        workSchedule.push({ atMinute, id });
        workDurationById.set(id, block.durationMinutes);
      }
    }
  }
  workSchedule.sort((a, b) => a.atMinute - b.atMinute);
  const workByMinute = new Map<number, string[]>();
  for (const w of workSchedule) {
    const list = workByMinute.get(w.atMinute) ?? [];
    list.push(w.id);
    workByMinute.set(w.atMinute, list);
  }

  let running: RunningEntry[] = [];
  let queued: WorkItem[] = [];
  let placements = 0;
  let chosen = 0;
  let workEnds = 0;
  let hostChanges = 0;

  let eligibility = refreshEligibility(hostMap, [], config);
  const initialAliases = [...hostMap.keys()].sort();
  for (const alias of initialAliases) {
    const state = hostMap.get(alias);
    if (state === undefined) {
      continue;
    }
    const elig = eligibility.get(alias) ?? { eligible: false, excludeReason: "offline" };
    const runningCount = countRunningForHost(running, alias);
    const computedState = computeState(state.hostCapacity, state.offline, runningCount, elig);
    lines.push({
      kind: "host",
      atMinute: 0,
      at: isoAtMinute(timeline.startAt, 0),
      alias,
      hostKind: state.hostKind,
      site: state.site,
      state: computedState,
      eligible: elig.eligible,
      excludeReason: elig.excludeReason,
      running: runningCount,
      maxAgents: state.hostCapacity.policy.maxConcurrentAgents,
      batteryPercent: state.hostCapacity.batteryPercent,
      simulated: true,
    });
  }

  for (let atMinute = 0; atMinute <= timeline.durationMinutes; atMinute += 1) {
    const at = isoAtMinute(timeline.startAt, atMinute);
    let hostChangedThisMinute = false;
    const changedAliases = new Set<string>();

    const eventsNow = eventsByMinute.get(atMinute) ?? [];
    for (const ev of eventsNow) {
      const hostState = hostMap.get(ev.alias);
      if (hostState === undefined) {
        continue;
      }
      const beforeCapacityJson = JSON.stringify(hostState.hostCapacity);
      const beforeOffline = hostState.offline;
      let afterCapacity = hostState.hostCapacity;
      let afterOffline = hostState.offline;
      switch (ev.type) {
        case "leave": {
          afterCapacity = {
            ...afterCapacity,
            idle: true,
            secondsSinceInput: 1800,
            idleReason: "no user input for 30 minutes, on AC power",
            timestamp: at,
          };
          break;
        }
        case "return": {
          afterCapacity = {
            ...afterCapacity,
            idle: false,
            secondsSinceInput: 0,
            idleReason: "user input 0 seconds ago",
            timestamp: at,
          };
          break;
        }
        case "depart": {
          afterOffline = true;
          break;
        }
        case "rejoin": {
          afterOffline = false;
          const set = ev.set ?? {};
          const acPower = set["acPower"];
          if (typeof acPower === "boolean") {
            afterCapacity = { ...afterCapacity, acPower, timestamp: at };
          } else {
            afterCapacity = { ...afterCapacity, timestamp: at };
          }
          if ("batteryPercent" in set) {
            const bp = set["batteryPercent"];
            if (typeof bp === "number") {
              afterCapacity = { ...afterCapacity, batteryPercent: bp, timestamp: at };
            }
          }
          break;
        }
        case "window-enter": {
          afterCapacity = {
            ...afterCapacity,
            policy: { ...afterCapacity.policy, insideWindow: true },
            timestamp: at,
          };
          if (hostState.hostKind === "kiosk") {
            afterCapacity = {
              ...afterCapacity,
              idle: true,
              secondsSinceInput: 7200,
              idleReason:
                "unattended window: no input on the local session for 120 minutes, on AC power",
              timestamp: at,
            };
          }
          break;
        }
        case "window-exit": {
          afterCapacity = {
            ...afterCapacity,
            policy: { ...afterCapacity.policy, insideWindow: false },
            idle: false,
            idleReason: "outside the policy window",
            timestamp: at,
          };
          break;
        }
        case "battery": {
          const set = ev.set ?? {};
          const bp = set["batteryPercent"];
          if (typeof bp === "number") {
            afterCapacity = { ...afterCapacity, batteryPercent: bp, timestamp: at };
          }
          break;
        }
        case "unplug": {
          afterCapacity = { ...afterCapacity, acPower: false, timestamp: at };
          break;
        }
        case "plug-in": {
          afterCapacity = { ...afterCapacity, acPower: true, timestamp: at };
          break;
        }
        default:
          break;
      }
      if (!isHostCapacity(afterCapacity)) {
        throw new Error(
          `Timeline event at ${String(atMinute)} for ${ev.alias}: invalid HostCapacity`,
        );
      }
      const afterJson = JSON.stringify(afterCapacity);
      if (afterJson !== beforeCapacityJson || afterOffline !== beforeOffline) {
        hostMap.set(ev.alias, {
          hostCapacity: afterCapacity,
          offline: afterOffline,
          hostKind: hostState.hostKind,
          site: hostState.site,
        });
        if (!changedAliases.has(ev.alias)) {
          changedAliases.add(ev.alias);
          hostChangedThisMinute = true;
        }
      }
      const text = eventText(ev.alias, ev.type, ev.set as Record<string, unknown> | undefined);
      lines.push({
        kind: "event",
        atMinute,
        at,
        alias: ev.alias,
        event: ev.type,
        text,
        simulated: true,
      });
    }

    let workEndedThisMinute = false;
    const workEndAliases: string[] = [];
    const remainingRunning: RunningEntry[] = [];
    for (const entry of running) {
      if (entry.endMinute === atMinute) {
        lines.push({
          kind: "work-end",
          atMinute,
          at,
          workItemId: entry.workItem.id,
          hostAlias: entry.hostAlias,
          simulated: true,
        });
        workEnds += 1;
        workEndedThisMinute = true;
        workEndAliases.push(entry.hostAlias);
      } else {
        remainingRunning.push(entry);
      }
    }
    if (workEndedThisMinute) {
      running = remainingRunning;
    }

    if (hostChangedThisMinute || workEndedThisMinute) {
      const runningItemsForEligibility = running.map((r) => r.workItem);
      eligibility = refreshEligibility(hostMap, runningItemsForEligibility, config);
    }

    const arriving = workByMinute.get(atMinute) ?? [];
    for (const workId of arriving) {
      queued.push(createQueuedWorkItem(workId));
    }
    const placedAliases: string[] = [];
    if (queued.length > 0) {
      const snapshotQueue = [...queued];
      const newQueued: WorkItem[] = [];
      let placementsThisMinuteNeedRefresh = false;
      const getOnlineHosts = (): HostCapacity[] => {
        const online: HostCapacity[] = [];
        for (const state of hostMap.values()) {
          if (!state.offline) {
            online.push(state.hostCapacity);
          }
        }
        online.sort((a, b) => (a.hostAlias < b.hostAlias ? -1 : a.hostAlias > b.hostAlias ? 1 : 0));
        return online;
      };
      for (const item of snapshotQueue) {
        const onlineHosts = getOnlineHosts();
        const runningItems = running.map((r) => r.workItem);
        const decision = place(item, onlineHosts, runningItems, config);
        const eligibleCount = decision.candidates.filter((c) => !c.excluded).length;
        lines.push({
          kind: "placement",
          atMinute,
          at,
          workItemId: item.id,
          chosenHostAlias: decision.chosenHostAlias,
          reason: decision.reason,
          eligibleCount,
          candidates: [...decision.candidates],
          simulated: true,
        });
        placements += 1;
        if (decision.chosenHostAlias !== null) {
          chosen += 1;
          const hostAlias = decision.chosenHostAlias;
          const duration = workDurationById.get(item.id) ?? 25;
          const endMinute = atMinute + duration;
          const runningItem = createWorkItem(item.id, hostAlias);
          running.push({ workItem: runningItem, hostAlias, endMinute });
          placementsThisMinuteNeedRefresh = true;
          placedAliases.push(hostAlias);
        } else {
          newQueued.push(item);
        }
      }
      queued = newQueued;
      if (placementsThisMinuteNeedRefresh) {
        const runningItemsForEligibility = running.map((r) => r.workItem);
        eligibility = refreshEligibility(hostMap, runningItemsForEligibility, config);
      }
    }

    for (const alias of placedAliases) {
      changedAliases.add(alias);
    }
    for (const alias of workEndAliases) {
      changedAliases.add(alias);
    }

    if (changedAliases.size > 0) {
      const sortedChanged = [...changedAliases].sort();
      for (const alias of sortedChanged) {
        const state = hostMap.get(alias);
        if (state === undefined) {
          continue;
        }
        const elig = eligibility.get(alias) ?? { eligible: false, excludeReason: "offline" };
        const runningCount = countRunningForHost(running, alias);
        const computedState = computeState(state.hostCapacity, state.offline, runningCount, elig);
        lines.push({
          kind: "host",
          atMinute,
          at,
          alias,
          hostKind: state.hostKind,
          site: state.site,
          state: computedState,
          eligible: elig.eligible,
          excludeReason: elig.excludeReason,
          running: runningCount,
          maxAgents: state.hostCapacity.policy.maxConcurrentAgents,
          batteryPercent: state.hostCapacity.batteryPercent,
          simulated: true,
        });
        hostChanges += 1;
      }
    }
  }

  const unplaced = placements - chosen;
  lines.push({
    kind: "summary",
    placements,
    chosen,
    unplaced,
    workEnds,
    hostChanges: hostChanges + initialAliases.length,
    simulated: true,
  });

  return lines;
}
