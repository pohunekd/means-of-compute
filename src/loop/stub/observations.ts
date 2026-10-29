// Stub host observations: the file holds HostCapacity documents, each
// reported on every collect with the stub plugin identity.
import { readFile } from "node:fs/promises";
import { isHostCapacity } from "../../../contracts/v1/validate.js";
import type { HostObservation, HostStateCollector } from "../../hoststate/collector.js";
import { sha256Hex } from "../../work/canonical.js";

export class StubObservationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubObservationsError";
  }
}

// Re-read the file on every collect; each entry must pass the contract.
export function createStubCollector(path: string, now: () => Date): HostStateCollector {
  async function collect(): Promise<readonly HostObservation[]> {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new StubObservationsError("stub observations file must hold an array");
    }
    const digest = `sha256:${sha256Hex(text)}`;
    return parsed.map((entry) => {
      if (!isHostCapacity(entry)) {
        throw new StubObservationsError("stub observations entry is not HostCapacity");
      }
      return {
        kind: "reported",
        hostAlias: entry.hostAlias,
        observedAt: now().toISOString(),
        plugin: { packageId: "moc.stub-hosts", version: "0.1.0", digest },
        capacity: entry,
      } as const;
    });
  }
  return { collect };
}
