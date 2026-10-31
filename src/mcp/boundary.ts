// MCP runtime boundary (A9): preloaded by every MCP server launcher
// (src/mcp/launch.ts). A Bun plugin refuses to load the approvals
// decide module or CLI, matched by file identity, however the specifier is
// built; the global marker tells serve.ts and decide.ts that it runs.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOUNDARY_MARKER } from "./boundary-marker.js";

// onLoad sees the real path plus any query or hash. The name filter is
// case-insensitive for case-insensitive file systems; the device and inode
// check decides, so symlinks and hard links match too.
const CANDIDATE = /\/(?:decide|cli)\.ts(?:[?#].*)?$/i;
const SUFFIX = /[?#].*$/s;

function identityOf(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${String(stat.dev)}:${String(stat.ino)}`;
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

Bun.plugin({
  name: "mcp-boundary",
  setup(build) {
    build.onLoad({ filter: CANDIDATE }, (args) => {
      const path = args.path.replace(SUFFIX, "");
      const name = refused.get(identityOf(path) ?? "");
      if (name !== undefined) {
        throw new Error(`mcp boundary: refused ${name}`);
      }
      // onLoad has no fall-through: any other matching file loads as TypeScript.
      return { contents: readFileSync(path, "utf8"), loader: "ts" };
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

Object.defineProperty(globalThis, BOUNDARY_MARKER, {
  value: true,
  writable: false,
  configurable: false,
  enumerable: false,
});
