// How every launcher starts the MCP server (docs/mcp.md, A9). The server's
// own Bun config replaces any bunfig.toml of the working directory, so no
// checkout preload runs, and the runtime boundary is preloaded before the
// entry. The working directory is left to the launcher: relative paths in
// the MCP config resolve against it. Arguments after the entry go to serve.ts.
import { join } from "node:path";

export const MCP_BUN_CONFIG = "config/mcp-bunfig.toml";
export const MCP_BOUNDARY = "src/mcp/boundary.ts";
export const MCP_SERVE_ENTRY = "src/mcp/serve.ts";

export function mcpServeArgs(checkoutDir: string): readonly string[] {
  return [
    `--config=${join(checkoutDir, MCP_BUN_CONFIG)}`,
    `--preload=${join(checkoutDir, MCP_BOUNDARY)}`,
    join(checkoutDir, MCP_SERVE_ENTRY),
  ];
}
