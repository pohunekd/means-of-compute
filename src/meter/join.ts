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
    { provider: string; model: string; inputs: (number | null)[]; outputs: (number | null)[] }
  >();
  for (const callId of index.startOrder) {
    const start = index.starts.get(callId);
    if (start === undefined || start.requestId !== requestId) {
      continue;
    }
    const key = JSON.stringify([start.providerId, start.model]);
    const end = index.ends.get(callId);
    let inputs: (number | null)[];
    let outputs: (number | null)[];
    if (end === undefined) {
      // A crash after send leaves a start without an end: billed, unknown.
      inputs = [null];
      outputs = [null];
    } else if (!end.billed) {
      continue;
    } else {
      inputs = [end.inputTokens];
      outputs = [end.outputTokens];
    }
    let group = groups.get(key);
    if (group === undefined) {
      group = { provider: start.providerId, model: start.model, inputs: [], outputs: [] };
      groups.set(key, group);
      groupOrder.push(key);
    }
    group.inputs.push(...inputs);
    group.outputs.push(...outputs);
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
        inputs: (number | null)[];
        outputs: (number | null)[];
      };
      return {
        provider: group.provider,
        model: group.model,
        inputTokens: nullSum(group.inputs),
        outputTokens: nullSum(group.outputs),
        requests: group.inputs.length,
        source: METER_SOURCE,
      };
    }),
  };
}

function nullSum(values: readonly (number | null)[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    sum += value;
  }
  return sum;
}
