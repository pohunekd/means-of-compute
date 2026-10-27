import {
  HostStateError,
  type HostStateFailure,
  type HostStateLimits,
  type HostStatePort,
  type HostStateReply,
} from "./port.js";

export type MemoryHostBehaviour =
  | { readonly kind: "reply"; readonly reply: HostStateReply }
  | { readonly kind: "fail"; readonly failure: HostStateFailure; readonly code: string | null }
  | { readonly kind: "hang" }
  | { readonly kind: "throw"; readonly error: Error };

export interface MemoryHostCall {
  readonly hostAlias: string;
  readonly packageId: string;
  readonly limits: HostStateLimits;
}

export interface MemoryHostStateControl {
  readonly port: HostStatePort;
  set(hostAlias: string, behaviour: MemoryHostBehaviour): void;
  calls(): readonly MemoryHostCall[];
}

export function createMemoryHostStatePort(aliases: readonly string[]): MemoryHostStateControl {
  const seen = new Set<string>();
  for (const alias of aliases) {
    if (seen.has(alias)) {
      throw new Error(`Duplicate host alias ${alias}`);
    }
    seen.add(alias);
  }
  const order = [...aliases];
  const behaviours = new Map<string, MemoryHostBehaviour>();
  const recorded: MemoryHostCall[] = [];

  function hosts(): readonly string[] {
    return [...order];
  }

  function read(
    hostAlias: string,
    packageId: string,
    limits: HostStateLimits,
  ): Promise<HostStateReply> {
    if (!seen.has(hostAlias)) {
      throw new Error(`Unknown host alias ${hostAlias}`);
    }
    const behaviour = behaviours.get(hostAlias);
    if (behaviour === undefined) {
      throw new Error(`No behaviour set for host ${hostAlias}`);
    }
    recorded.push({ hostAlias, packageId, limits });
    if (behaviour.kind === "reply") {
      return Promise.resolve(behaviour.reply);
    }
    if (behaviour.kind === "fail") {
      return Promise.reject(new HostStateError(behaviour.failure, behaviour.code));
    }
    if (behaviour.kind === "throw") {
      return Promise.reject(behaviour.error);
    }
    return new Promise<HostStateReply>(() => {});
  }

  function close(): Promise<void> {
    return Promise.resolve();
  }

  function set(hostAlias: string, behaviour: MemoryHostBehaviour): void {
    if (!seen.has(hostAlias)) {
      throw new Error(`Unknown host alias ${hostAlias}`);
    }
    behaviours.set(hostAlias, behaviour);
  }

  function calls(): readonly MemoryHostCall[] {
    return [...recorded];
  }

  return { port: { hosts, read, close }, set, calls };
}
