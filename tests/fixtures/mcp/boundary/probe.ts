// Boundary probe, preloaded after the runtime boundary: once the server
// prints "serving as", it tries each loader form of the PR #93 round 2
// findings F2 and F3 inside the server process and prints one
// "boundary-probe <json>" line, mapping each form to the message that
// refused it, or "loaded".
import { fileURLToPath } from "node:url";

const approvals = fileURLToPath(new URL("../../../../src/approvals/", import.meta.url));
const decidePath = approvals + ["dec", "ide.ts"].join("");
const cliPath = approvals + ["c", "li.ts"].join("");

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attempt(load: () => Promise<unknown>): Promise<string> {
  try {
    await load();
    return "loaded";
  } catch (error: unknown) {
    return messageOf(error);
  }
}

type Loader = (path: string) => unknown;

const forms: Record<string, () => Promise<unknown>> = {
  // F2: dynamic import() of a built specifier.
  // eslint-disable-next-line no-restricted-syntax -- the form under test
  import: () => import(decidePath),
  // F2: getBuiltinModule and createRequire read with built property names.
  createRequire: () => {
    const getBuiltin = Reflect.get(process, ["getBuiltin", "Module"].join("")) as (
      name: string,
    ) => object;
    const moduleApi = getBuiltin.call(process, ["node:", "module"].join(""));
    const create = Reflect.get(moduleApi, ["create", "Require"].join("")) as (
      url: string,
    ) => Loader;
    return Promise.resolve(create(import.meta.url)(cliPath));
  },
  // F3: a function constructor reached through .constructor with a built body.
  functionConstructor: () => {
    const FunctionClass = messageOf.constructor as new (
      ...args: string[]
    ) => (path: string) => Promise<unknown>;
    return new FunctionClass("path", ["return imp", "ort(path)"].join(""))(decidePath);
  },
  clearAll: () => {
    (Reflect.get(Bun.plugin, ["clear", "All"].join("")) as () => void)();
    // eslint-disable-next-line no-restricted-syntax -- the form under test
    return import(decidePath);
  },
  worker: () => {
    const WorkerClass = Reflect.get(globalThis, ["Wor", "ker"].join("")) as new (url: string) => {
      onmessage: ((event: MessageEvent<string>) => void) | null;
      terminate(): void;
    };
    const worker = new WorkerClass(new URL("./probe-worker.ts", import.meta.url).href);
    return new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event) => {
        worker.terminate();
        if (event.data === "loaded") {
          resolve(event.data);
        } else {
          reject(new Error(event.data));
        }
      };
    });
  },
  tamper: async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the values under test
    const mapGet = Map.prototype.get;

    const getOwn = Object.getOwnPropertyDescriptor;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the values under test
    const replace = String.prototype.replace;
    const main = Bun.main;
    (Map.prototype as unknown as Record<string, unknown>)["get"] = () => undefined;
    (Object as unknown as Record<string, unknown>)["getOwnPropertyDescriptor"] = () => undefined;
    (String.prototype as unknown as Record<string, unknown>)["replace"] = function (this: string) {
      return this;
    };
    Reflect.set(Bun, ["ma", "in"].join(""), "/y");
    try {
      // eslint-disable-next-line no-restricted-syntax -- the form under test
      await import(decidePath);
    } finally {
      Map.prototype.get = mapGet;
      Object.getOwnPropertyDescriptor = getOwn;
      String.prototype.replace = replace;
      Reflect.set(Bun, ["ma", "in"].join(""), main);
    }
  },
};

const write = process.stderr.write.bind(process.stderr);
let started = false;
process.stderr.write = (chunk: string | Uint8Array, ...rest: never[]) => {
  const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  if (!started && text.includes("mcp: serving as")) {
    started = true;
    void (async () => {
      const results: Record<string, string> = {};
      for (const [name, load] of Object.entries(forms)) {
        results[name] = await attempt(load);
      }
      write(`boundary-probe ${JSON.stringify(results)}\n`);
    })();
  }
  return write(chunk, ...rest);
};
