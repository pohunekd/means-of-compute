// Pure join of usage-log records into the PortUsage of design section 4.4.
// Unknown and unbilled rules live here; nothing here touches the filesystem.
import type { PortUsage } from "../dispatcher/port.js";
import type { UsageIndex } from "./usage-log.js";

const METER_SOURCE = "meter-proxy";

export function joinUsage(index: UsageIndex, requestId: string): PortUsage {
  const grant = index.grants.get(requestId);
  if (grant === undefined) {
    throw new Error(`meter: joinUsage without a grant for "${requestId}"`);
  }
  const groupOrder: string[] = [];
  const groups = new Map<
    string,
    {
      provider: string;
      model: string;
      input: number;
      output: number;
      measured: number;
      unmeasured: number;
    }
  >();
  for (const callId of index.startOrder) {
    const start = index.starts.get(callId);
    if (start === undefined || start.requestId !== requestId) {
      continue;
    }
    const key = JSON.stringify([start.providerId, start.model]);
    const end = index.ends.get(callId);
    if (end !== undefined && !end.billed) {
      continue;
    }
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        provider: start.providerId,
        model: start.model,
        input: 0,
        output: 0,
        measured: 0,
        unmeasured: 0,
      };
      groups.set(key, group);
      groupOrder.push(key);
    }
    // A billed call without both counts (a timeout, a body without usage, or a
    // start without an end after a crash) is counted, not summed.
    if (end === undefined || end.inputTokens === null || end.outputTokens === null) {
      group.unmeasured += 1;
    } else {
      group.input += end.inputTokens;
      group.output += end.outputTokens;
      group.measured += 1;
    }
  }
  if (groupOrder.length === 0) {
    return {
      tokens: [
        {
          provider: grant.open.providerId,
          model: grant.open.model,
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
          source: METER_SOURCE,
        },
      ],
    };
  }
  return {
    tokens: groupOrder.map((key) => {
      const group = groups.get(key) as {
        provider: string;
        model: string;
        input: number;
        output: number;
        measured: number;
        unmeasured: number;
      };
      return {
        provider: group.provider,
        model: group.model,
        inputTokens: group.input,
        outputTokens: group.output,
        requests: group.measured + group.unmeasured,
        source: METER_SOURCE,
        ...(group.unmeasured > 0 ? { unmeasuredRequests: group.unmeasured } : {}),
      };
    }),
  };
}
