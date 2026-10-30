import { readWorkStore } from "../src/work/store.js";
import { loadWorkConfig } from "../src/work/config.js";
import { summarizeStore } from "../src/work/summary.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let storePath: string | undefined;
  let errorMsg: string | undefined;

  if (args.length > 0) {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--store") {
        if (storePath !== undefined) {
          errorMsg = "repeated --store";
          break;
        }
        const next = args[i + 1];
        if (!next || next.startsWith("--")) {
          errorMsg = "--store requires a value";
          break;
        }
        storePath = next;
        i += 2;
        continue;
      }
      errorMsg = 'unknown argument "' + String(arg) + '"';
      break;
    }
  }

  if (errorMsg) {
    console.error("work:summary: " + errorMsg);
    process.exit(2);
  }

  try {
    let store;
    if (storePath) {
      store = await readWorkStore(storePath);
    } else {
      const cfg = await loadWorkConfig();
      store = await readWorkStore(cfg.storePath);
    }
    const summary = summarizeStore(store);
    console.log(JSON.stringify(summary));
    process.exit(0);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("work:summary: " + message);
    process.exit(2);
  }
}

void main();
