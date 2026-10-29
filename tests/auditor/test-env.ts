// Shared test environment for auditor tests (L3): placeholder API keys
// are applied per test and restored in finally, so no test leaks keys
// into later files in the same process. The budget gates are stubs that
// print what the real check prints, so no test runs the real gate
// against the checkout's logs/.
import { createCliBudgetGate, type BudgetGate } from "../../src/budget/gate.js";
import { resetProvidersCache } from "../../src/providers/config.js";

const KEYS = [
  "NVIDIA_API_KEY",
  "META_API_KEY",
  "LOCAL_MODEL_BASE_URL",
  "PROVIDER_META_API_BASE_URL",
  "PROVIDER_NVIDIA_BUILD_BASE_URL",
  "PROVIDER_META_WONDER_BASE_URL",
  "PROVIDER_META_API_TIMEOUT_MS",
] as const;

export function applyTestEnv(): () => void {
  const before = new Map<string, string | undefined>();
  for (const key of KEYS) {
    before.set(key, process.env[key]);
  }
  process.env.NVIDIA_API_KEY = "test";
  process.env.META_API_KEY = "test";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  resetProvidersCache();
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    resetProvidersCache();
  };
}

// Prints what the real check prints for admit (rc 0):
// "admitted: <reason> (today $0.00, total $0.00, nvidia requests today 0)".
export function admittingGate(cwd: string): BudgetGate {
  return createCliBudgetGate({
    command: [
      "bun",
      "-e",
      'console.log("admitted: test admit (today $0.00, total $0.00, nvidia requests today 0)");',
    ],
    timeoutMs: 30000,
    cwd,
    env: { ...process.env } as Record<string, string>,
  });
}

// Prints what the real check prints for refuse (rc 3):
// "refused: <reason> (today $0.00, total $0.00, nvidia requests today 0)".
export function refusingGate(cwd: string): BudgetGate {
  return createCliBudgetGate({
    command: [
      "bun",
      "-e",
      'console.log("refused: test refuse (today $0.00, total $0.00, nvidia requests today 0)"); process.exit(3);',
    ],
    timeoutMs: 30000,
    cwd,
    env: { ...process.env } as Record<string, string>,
  });
}
