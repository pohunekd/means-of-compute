// MCP runtime boundary (A9, #94): a server started the way every launcher
// starts it refuses the approvals decide module and CLI for each F2/F3
// loader form, and a server started without the boundary does not serve.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createMcpTestEnv } from "./env.js";
import { MCP_SERVE_ENTRY, mcpServeArgs } from "../../src/mcp/launch.ts";

const PROBE = join(process.cwd(), "tests", "fixtures", "mcp", "boundary", "probe.ts");
const REFUSED_DECIDE = "mcp boundary: refused src/approvals/decide.ts";

async function stderrLine(stream: ReadableStream<Uint8Array>, prefix: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    const line = text.split("\n").find((entry) => entry.startsWith(prefix));
    if (line !== undefined) {
      return line.slice(prefix.length);
    }
  }
  throw new Error(`stderr ended without "${prefix}": ${text}`);
}

test("the started server refuses every F2/F3 loader form (BD1)", async () => {
  const env = await createMcpTestEnv("mcp-boundary-");
  const proc = Bun.spawn(
    [
      process.execPath,
      `--preload=${PROBE}`,
      ...mcpServeArgs(process.cwd()),
      "--caller",
      "mcp-call",
      "--config",
      env.mcpConfigPath,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const results = JSON.parse(await stderrLine(proc.stderr, "boundary-probe ")) as unknown;
  await proc.stdin.end();
  expect(await proc.exited).toBe(0);
  expect(results).toEqual({
    import: REFUSED_DECIDE,
    createRequire: "mcp boundary: refused src/approvals/cli.ts",
    functionConstructor: REFUSED_DECIDE,
    clearAll: "mcp boundary: plugins are locked",
    worker: "approvals: decide.ts refuses to load in the MCP server process",
  });
});

test("a server started without the boundary exits 2 before serving (BD2)", async () => {
  const env = await createMcpTestEnv("mcp-boundary-");
  const proc = Bun.spawn(
    [process.execPath, MCP_SERVE_ENTRY, "--caller", "mcp-call", "--config", env.mcpConfigPath],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  await proc.stdin.end();
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain("mcp: runtime boundary not installed");
  expect(await new Response(proc.stdout).text()).toBe("");
  expect(existsSync(env.callLogPath)).toBe(false);
});
