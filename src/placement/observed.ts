import { isPlacementDecision } from "../../contracts/v1/validate.js";
import type { PlacementDecision, WorkItem } from "../../contracts/v1/types.js";
import type { HostObservation } from "../hoststate/collector.js";
import type { PlacementConfig } from "./config.js";
import { place } from "./place.js";

export function placeObserved(
  item: WorkItem,
  observations: readonly HostObservation[],
  running: readonly WorkItem[],
  config: PlacementConfig,
): PlacementDecision {
  const seen = new Set<string>();
  for (const observation of observations) {
    if (seen.has(observation.hostAlias)) {
      throw new Error(`Duplicate host alias ${observation.hostAlias}`);
    }
    seen.add(observation.hostAlias);
  }
  const reported = observations.filter((entry) => entry.kind === "reported");
  const decision = place(
    item,
    reported.map((entry) => entry.capacity),
    running,
    config,
  );
  const candidates = [...decision.candidates];
  for (const observation of observations) {
    if (observation.kind === "unavailable") {
      candidates.push({
        hostAlias: observation.hostAlias,
        score: 0,
        reason: `excluded: host state unavailable (${observation.cause})`,
        excluded: true,
      });
    }
  }
  const result: PlacementDecision =
    decision.chosenHostAlias === null
      ? {
          ...decision,
          reason: `no eligible host: ${String(candidates.length)} of ${String(candidates.length)} excluded`,
          candidates,
        }
      : { ...decision, candidates };
  if (!isPlacementDecision(result)) {
    throw new Error("Observed placement produced a decision that fails the contract");
  }
  return result;
}
