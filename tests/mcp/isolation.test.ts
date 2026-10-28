// MCP boundary test (matrix X4, REFINED by AM4-5): no file under
// src/mcp/ names the decide module or the atomic writer, so no MCP call
// can decide a request or write a file directly (A9).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("no file under src/mcp/ names decide or the atomic writer (X4, A9)", () => {
  const dir = join(process.cwd(), "src", "mcp");
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    expect(text).not.toContain("approvals/decide");
    expect(text).not.toContain("writeFileAtomic");
  }
});
