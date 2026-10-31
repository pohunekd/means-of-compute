// Host start cooldown: a host whose start-rejected rounds, over every item,
// reach `rejections` within `windowMs` is cooled until `cooldownMs` after the
// rejection that reached the count. It is derived from the stored rounds, so
// it survives a restart without state of its own. Every rejection code counts;
// a lost round does not.
import type { LoopHostCooldownConfig } from "./config.js";
import type { LoopItem } from "./types.js";

// Cooled host aliases mapped to the epoch ms their cooldown ends.
export function cooledHosts(
  items: readonly Pick<LoopItem, "rounds">[],
  config: LoopHostCooldownConfig,
  nowMs: number,
): Map<string, number> {
  const byHost = new Map<string, number[]>();
  for (const li of items) {
    for (const record of li.rounds) {
      if (record.outcome !== "start-rejected" || record.hostAlias === null) {
        continue;
      }
      const times = byHost.get(record.hostAlias) ?? [];
      times.push(Date.parse(record.at));
      byHost.set(record.hostAlias, times);
    }
  }
  const cooled = new Map<string, number>();
  for (const [hostAlias, times] of byHost) {
    times.sort((a, b) => a - b);
    // The latest run of `rejections` within the window sets the end.
    for (let last = times.length - 1; last >= config.rejections - 1; last -= 1) {
      const end = times[last];
      const first = times[last - config.rejections + 1];
      if (end === undefined || first === undefined) {
        break;
      }
      if (end - first <= config.windowMs) {
        if (nowMs < end + config.cooldownMs) {
          cooled.set(hostAlias, end + config.cooldownMs);
        }
        break;
      }
    }
  }
  return cooled;
}
