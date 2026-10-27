// Pure placement: score hosts against capacity and policy and return one
// PlacementDecision. No clock, no I/O; battery, AC, and window exclusions
// repeat the probe rule on purpose, so placement never trusts idle alone.
import { isPlacementDecision } from "../../contracts/v1/validate.js";
import type {
  HostCapacity,
  PlacementCandidate,
  PlacementDecision,
  WorkItem,
} from "../../contracts/v1/types.js";
import type { PlacementConfig } from "./config.js";

interface CandidateBuild {
  readonly candidate: PlacementCandidate;
  readonly loadRatio: number;
}

export function place(
  item: WorkItem,
  hosts: readonly HostCapacity[],
  running: readonly WorkItem[],
  config: PlacementConfig,
): PlacementDecision {
  const built: CandidateBuild[] = hosts.map((host) => buildCandidate(host, running, config));
  const candidates: PlacementCandidate[] = built.map((entry) => entry.candidate);
  const eligible = built.filter((entry) => !entry.candidate.excluded);
  if (eligible.length === 0) {
    const decision: PlacementDecision = {
      schemaVersion: "v1",
      workItemId: item.id,
      chosenHostAlias: null,
      reason: `no eligible host: ${String(candidates.length)} of ${String(candidates.length)} excluded`,
      candidates,
    };
    assertValidDecision(decision);
    return decision;
  }
  let winner = eligible[0];
  if (winner === undefined) {
    throw new Error("Placement: no eligible host candidate");
  }
  for (const entry of eligible.slice(1)) {
    if (isBetter(entry, winner)) {
      winner = entry;
    }
  }
  const winnerHost = hosts.find((host) => host.hostAlias === winner.candidate.hostAlias);
  if (winnerHost === undefined) {
    throw new Error("Placement: winning host not found in input");
  }
  const runningCount = countRunningOnHost(running, winner.candidate.hostAlias);
  const decision: PlacementDecision = {
    schemaVersion: "v1",
    workItemId: item.id,
    chosenHostAlias: winner.candidate.hostAlias,
    reason:
      `${winner.candidate.hostAlias} is ${winner.candidate.reason}` +
      ` inside its policy window, ${String(runningCount)}/${String(winnerHost.policy.maxConcurrentAgents)} agents running`,
    candidates,
  };
  assertValidDecision(decision);
  return decision;
}

function isBetter(challenger: CandidateBuild, incumbent: CandidateBuild): boolean {
  if (challenger.candidate.score !== incumbent.candidate.score) {
    return challenger.candidate.score > incumbent.candidate.score;
  }
  if (challenger.loadRatio !== incumbent.loadRatio) {
    return challenger.loadRatio < incumbent.loadRatio;
  }
  return challenger.candidate.hostAlias < incumbent.candidate.hostAlias;
}

function buildCandidate(
  host: HostCapacity,
  running: readonly WorkItem[],
  config: PlacementConfig,
): CandidateBuild {
  const loadRatio = host.cpu.load1m / host.cpu.cores;
  if (!host.idle) {
    return {
      loadRatio,
      candidate: {
        hostAlias: host.hostAlias,
        score: 0,
        reason: `excluded: not idle (${host.idleReason})`,
        excluded: true,
      },
    };
  }
  if (!host.acPower) {
    return {
      loadRatio,
      candidate: {
        hostAlias: host.hostAlias,
        score: 0,
        reason: "excluded: not on AC power",
        excluded: true,
      },
    };
  }
  if (host.batteryPercent !== null && host.batteryPercent <= config.batteryFloorPercent) {
    return {
      loadRatio,
      candidate: {
        hostAlias: host.hostAlias,
        score: 0,
        reason: `excluded: battery at ${String(host.batteryPercent)} percent, at or below the ${String(config.batteryFloorPercent)} percent floor`,
        excluded: true,
      },
    };
  }
  if (!host.policy.insideWindow) {
    return {
      loadRatio,
      candidate: {
        hostAlias: host.hostAlias,
        score: 0,
        reason: "excluded: outside policy window",
        excluded: true,
      },
    };
  }
  const runningCount = countRunningOnHost(running, host.hostAlias);
  if (runningCount >= host.policy.maxConcurrentAgents) {
    return {
      loadRatio,
      candidate: {
        hostAlias: host.hostAlias,
        score: 0,
        reason: `excluded: at agent limit (${String(runningCount)}/${String(host.policy.maxConcurrentAgents)})`,
        excluded: true,
      },
    };
  }
  const cpuFree = Math.max(0, 1 - loadRatio);
  const memFree = host.memory.freeMb / host.memory.totalMb;
  const gpuFree = host.gpu.present ? 1 : 0;
  const score = round4(
    config.weights.cpu * cpuFree + config.weights.memory * memFree + config.weights.gpu * gpuFree,
  );
  const powerText =
    host.batteryPercent === null
      ? "idle, on AC power, no battery"
      : `idle, on AC power, battery ${String(host.batteryPercent)}%`;
  const cpuPercent = Math.round(cpuFree * 100);
  const memPercent = Math.round(memFree * 100);
  const gpuText = host.gpu.present ? ", GPU" : "";
  return {
    loadRatio,
    candidate: {
      hostAlias: host.hostAlias,
      score,
      reason: `${powerText}, CPU ${String(cpuPercent)}% free, memory ${String(memPercent)}% free${gpuText}`,
      excluded: false,
    },
  };
}

function countRunningOnHost(running: readonly WorkItem[], hostAlias: string): number {
  return running.filter(
    (entry) => entry.status === "running" && entry.assignedHostAlias === hostAlias,
  ).length;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function assertValidDecision(decision: PlacementDecision): void {
  if (!isPlacementDecision(decision)) {
    throw new Error("Placement produced a decision that fails the PlacementDecision contract");
  }
}
