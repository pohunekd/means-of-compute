export interface LoopbackResponse {
  status: number;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
  sseChunks?: readonly string[];
  chunkDelayMs?: number;
  holdBeforeHeaders?: boolean;
  holdAfterChunks?: number;
}

export interface LoopbackRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export async function startLoopback(recordingsPath: string): Promise<{
  port: number;
  stop: () => void | Promise<void>;
  requests(): readonly LoopbackRequest[];
  release(): void;
  waitHeld(count: number): Promise<void>;
}> {
  const file = Bun.file(recordingsPath);
  const text = await file.text();
  const responses = JSON.parse(text) as LoopbackResponse[];
  const seen: LoopbackRequest[] = [];
  let index = 0;
  // Hold gates serialize the deterministic tests: each reached hold bumps
  // the counter and waits for the current gate; release() opens the gate
  // once and installs a fresh one for the next hold.
  let held = 0;
  let gate: Promise<void> = Promise.resolve();
  let openGate: () => void = () => {};
  const waiters: Array<() => void> = [];
  const reachHold = async (): Promise<void> => {
    held += 1;
    for (const wake of waiters.splice(0)) {
      wake();
    }
    await gate;
  };
  const nextGate = (): void => {
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
  };
  nextGate();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers,
        body: await req.text(),
      });
      const resp = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (!resp) {
        return new Response(JSON.stringify({ error: "no response" }), { status: 500 });
      }
      if (resp.holdBeforeHeaders === true) {
        await reachHold();
      }
      if (resp.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, resp.delayMs));
      }
      if (resp.sseChunks !== undefined) {
        const chunks = resp.sseChunks;
        const gap = resp.chunkDelayMs ?? 0;
        const holdAfter = resp.holdAfterChunks ?? chunks.length;
        const head = chunks.slice(0, holdAfter);
        const tail = chunks.slice(holdAfter);
        const stream = new ReadableStream({
          async start(controller) {
            for (const chunk of head) {
              if (gap > 0) {
                await new Promise((resolve) => setTimeout(resolve, gap));
              }
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            if (tail.length > 0) {
              await reachHold();
            }
            for (const chunk of tail) {
              if (gap > 0) {
                await new Promise((resolve) => setTimeout(resolve, gap));
              }
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: resp.status,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (resp.rawBody !== undefined) {
        return new Response(resp.rawBody, {
          status: resp.status,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response(JSON.stringify(resp.body), {
        status: resp.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return {
    port: server.port ?? 0,
    stop: () => {
      void server.stop();
    },
    requests: () => seen,
    release: () => {
      openGate();
      nextGate();
    },
    waitHeld: (count: number): Promise<void> => {
      if (held >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const wake = (): void => {
          if (held >= count) {
            resolve();
          } else {
            waiters.push(wake);
          }
        };
        waiters.push(wake);
      });
    },
  };
}
