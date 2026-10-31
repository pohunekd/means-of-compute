// MCP runtime boundary (A9): preloaded by every MCP server launcher
// (src/mcp/launch.ts). A Bun plugin refuses to load the approvals
// decide module or CLI, matched by file identity, however the specifier is
// built in the server's realm (a ShadowRealm load is refused by decide.ts);
// the global marker tells serve.ts and decide.ts that it runs.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOUNDARY_MARKER } from "./boundary-marker.js";

// Intrinsics captured at preload, before any server code runs, and called
// through bound or uncurried forms later code cannot redirect.
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured at preload
const uncurryThis = Function.prototype.bind.bind(Function.prototype.call) as <
  A extends unknown[],
  R,
>(
  fn: (...args: A) => R,
) => (self: unknown, ...args: A) => R;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured at preload
const indexOfOn = uncurryThis(String.prototype.indexOf) as (
  self: string,
  search: string,
  from: number,
) => number;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured at preload
const sliceOn = uncurryThis(String.prototype.slice) as (
  self: string,
  start: number,
  end: number,
) => string;
const statAt = (path: string): { dev: number; ino: number } => statSync(path);
const readAt = (path: string, encoding: "utf8"): string => readFileSync(path, encoding);

// onLoad sees the real path plus any query or hash. The name filter is
// case-insensitive for case-insensitive file systems; the device and inode
// check decides, so symlinks and hard links match too.
const CANDIDATE = /\/(?:decide|cli)\.ts(?:[?#].*)?$/i;

function stripSuffix(path: string): string {
  const query = indexOfOn(path, "?", 0);
  const hash = indexOfOn(path, "#", 0);
  const cut = query === -1 ? hash : hash === -1 ? query : query < hash ? query : hash;
  return cut === -1 ? path : sliceOn(path, 0, cut);
}

function identityOf(path: string): string | null {
  try {
    const info = statAt(path);
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- primitive ToString has no hook (A9)
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}

function refusedEntry(relative: string, name: string): [string, string] {
  const identity = identityOf(fileURLToPath(new URL(relative, import.meta.url)));
  if (identity === null) {
    throw new Error(`mcp boundary: cannot stat ${name}`);
  }
  return [identity, name];
}

const refused = new Map<string, string>([
  refusedEntry("../approvals/decide.ts", "src/approvals/decide.ts"),
  refusedEntry("../approvals/cli.ts", "src/approvals/cli.ts"),
]);

const refusedGet = refused.get.bind(refused);

Bun.plugin({
  name: "mcp-boundary",
  setup(build) {
    build.onLoad({ filter: CANDIDATE }, (args) => {
      const path = stripSuffix(args.path);
      const name = refusedGet(identityOf(path) ?? "");
      if (name !== undefined) {
        throw new Error(`mcp boundary: refused ${name}`);
      }
      // onLoad has no fall-through: any other matching file loads as TypeScript.
      return { contents: readAt(path, "utf8"), loader: "ts" };
    });
  },
});

// clearAll would drop the plugin. It is writable but not configurable, so it
// can be replaced once and then never again.
Object.defineProperty(Bun.plugin, "clearAll", {
  value: () => {
    throw new Error("mcp boundary: plugins are locked");
  },
  writable: false,
  configurable: false,
});

Object.defineProperty(Bun, BOUNDARY_MARKER, {
  value: true,
  writable: false,
  configurable: false,
  enumerable: false,
});
