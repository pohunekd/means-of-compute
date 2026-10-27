export interface LoopbackResponse {
  status: number;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
  sseChunks?: readonly string[];
  chunkDelayMs?: number;
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
}> {
  const file = Bun.file(recordingsPath);
  const text = await file.text();
  const responses = JSON.parse(text) as LoopbackResponse[];
  const seen: LoopbackRequest[] = [];
  let index = 0;
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
      if (resp.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, resp.delayMs));
      }
      if (resp.sseChunks !== undefined) {
        const chunks = resp.sseChunks;
        const gap = resp.chunkDelayMs ?? 0;
        const stream = new ReadableStream({
          async start(controller) {
            for (const chunk of chunks) {
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
  };
}
