// Pure placement: score hosts against capacity and policy and return one
// PlacementDecision. No clock, no I/O; the probe already decided idleness and
// the policy window, placement only reads those facts.
import { isPlacementDecision } from "../../contracts/v1/validate.js";
import type {
  HostCapacity,
  PlacementCandidate,
  PlacementDecision,
  WorkItem,
} from "../../contracts/v1/types.js";
import type { PlacementWeights } from "./config.js";

interface CandidateBuild {
  readonly candidate: PlacementCandidate;
  readonly loadRatio: number;
}

export function place(
  item: WorkItem,
  hosts: readonly HostCapacity[],
  running: readonly WorkItem[],
  weights: PlacementWeights,
): PlacementDecision {
  const built: CandidateBuild[] = hosts.map((host) => buildCandidate(host, running, weights));
  const candidates: PlacementCandidate[] = built.map((entry) => entry.candidate);
  const eligible = built.filter((entry) => !entry.candidate.excluded);
  if (eligible.length === 0) {
    const decision: PlacementDecision = {
      schemaVersion: "v1",
      workItemId: item.id,
      chosenHostAlias: null,
      reason: `no eligible host: ${candidates.length} of ${candidates.length} excluded`,
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
      ` inside its policy window, ${runningCount}/${winnerHost.policy.maxConcurrentAgents} agents running`,
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
  weights: PlacementWeights,
): CandidateBuild {
  const loadRatio = host.cpu.load1m / host.cpu.cores;
  if (host.idle === false) {
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
  if (host.policy.insideWindow === false) {
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
        reason: `excluded: at agent limit (${runningCount}/${host.policy.maxConcurrentAgents})`,
        excluded: true,
      },
    };
  }
  const cpuFree = Math.max(0, 1 - loadRatio);
  const memFree = host.memory.freeMb / host.memory.totalMb;
  const gpuFree = host.gpu.present ? 1 : 0;
  const score = round4(weights.cpu * cpuFree + weights.memory * memFree + weights.gpu * gpuFree);
  const powerText = host.batteryPercent === null ? "idle, no battery" : "idle, on AC power";
  const cpuPercent = Math.round(cpuFree * 100);
  const memPercent = Math.round(memFree * 100);
  const gpuText = host.gpu.present ? ", GPU" : "";
  return {
    loadRatio,
    candidate: {
      hostAlias: host.hostAlias,
      score,
      reason: `${powerText}, CPU ${cpuPercent}% free, memory ${memPercent}% free${gpuText}`,
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
