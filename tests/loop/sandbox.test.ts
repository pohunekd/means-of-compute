// Demo sandbox (design section 7, steps 4 and 5): a directory without the
// demo marker is refused and left untouched; a marked sandbox is reset,
// the registry file goes while its lock stays, and the seeded origin, the
// factory-owned directories and the budget copies point inside it.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSandbox, SandboxError } from "../../src/loop/stub/sandbox.js";

test("only a marked sandbox is reset, and the reset reseeds it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-sandbox-"));
  try {
    const demoRepoDir = join(dir, "demo-repo");
    mkdirSync(demoRepoDir);
    await Bun.write(join(demoRepoDir, "README.md"), "demo\n");
    const sandboxDir = join(dir, "sandbox");
    const registryPath = join(dir, "registry.json");
    const input = {
      sandboxDir,
      demoRepoDir,
      registryPath,
      ownedDirs: [join(sandboxDir, "verdicts"), join(sandboxDir, "digest")],
      configDir: "config",
      ledgerPath: join(sandboxDir, "ledger.jsonl"),
      git: { PATH: process.env.PATH ?? "", timeoutMs: 30_000 },
    };

    mkdirSync(sandboxDir);
    await Bun.write(join(sandboxDir, "keep.txt"), "not a demo\n");
    let refused: unknown = null;
    try {
      await prepareSandbox(input);
    } catch (error: unknown) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(SandboxError);
    expect((refused as Error).message).toBe("sandbox dir is not a loop demo sandbox");
    expect(readFileSync(join(sandboxDir, "keep.txt"), "utf8")).toBe("not a demo\n");

    await Bun.write(join(sandboxDir, ".loop-demo"), "");
    await Bun.write(registryPath, "{}\n");
    await Bun.write(`${registryPath}.lock`, "");
    const layout = await prepareSandbox(input);
    expect(existsSync(join(sandboxDir, "keep.txt"))).toBe(false);
    expect(existsSync(join(sandboxDir, ".loop-demo"))).toBe(true);
    expect(existsSync(registryPath)).toBe(false);
    expect(existsSync(`${registryPath}.lock`)).toBe(true);
    expect(readFileSync(join(layout.checkoutDir, "README.md"), "utf8")).toBe("demo\n");
    expect(existsSync(join(sandboxDir, "verdicts"))).toBe(true);
    expect(existsSync(join(sandboxDir, "digest"))).toBe(true);
    const budget = JSON.parse(readFileSync(join(sandboxDir, "config", "budget.json"), "utf8")) as {
      statePath: string;
      escalationLogPath: string;
      nvidiaProviderId: string;
    };
    expect(budget.statePath).toBe(join(sandboxDir, "budget-state.json"));
    expect(budget.escalationLogPath).toBe(join(sandboxDir, "budget-escalations.log"));
    expect(budget.nvidiaProviderId).toBe("nvidia-build");
    expect(JSON.parse(readFileSync(join(sandboxDir, "config", "ledger.json"), "utf8"))).toEqual({
      ledgerPath: join(sandboxDir, "ledger.jsonl"),
    });
    expect(existsSync(join(sandboxDir, "config", "providers", "meta-api.json"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
