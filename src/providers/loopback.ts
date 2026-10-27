export interface LoopbackResponse {
  status: number;
  body: unknown;
  delayMs?: number;
}

export async function startLoopback(recordingsPath: string): Promise<{
  port: number;
  stop: () => void | Promise<void>;
}> {
  const file = Bun.file(recordingsPath);
  const text = await file.text();
  const responses = JSON.parse(text) as LoopbackResponse[];
  let index = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      const resp = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (!resp) {
        return new Response(JSON.stringify({ error: "no response" }), { status: 500 });
      }
      if (resp.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, resp.delayMs));
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
  };
}
