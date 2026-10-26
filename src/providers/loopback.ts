export interface LoopbackResponse {
  status: number;
  body: unknown;
}

export function startLoopback(responses: LoopbackResponse[]): {
  port: number;
  stop: () => void | Promise<void>;
} {
  let index = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const resp = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (!resp) {
        return new Response(JSON.stringify({ error: "no response" }), { status: 500 });
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
