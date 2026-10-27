// Dashboard server tests. Each test names the mutation it must catch.
// The bind uses port 0, so no fixed port is invented; the Host allowlist
// comes from the bound port exactly as design 1.4 states.
import { afterEach, describe, expect, test } from "bun:test";
import { loadBudgetConfig } from "../../src/budget/config.js";
import { loadProviderRoute } from "../../src/providers/route.js";
import { providerDescriptorExists } from "../../src/providers/config.js";
import {
  startDashboard,
  type DashboardDeps,
  type DashboardLogEvent,
} from "../../src/dashboard/server.js";

let servers: { stop: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers) {
    await server.stop();
  }
  servers = [];
});

async function startTestServer(logged: DashboardLogEvent[]): Promise<{ port: number }> {
  const budget = await loadBudgetConfig();
  const route = await loadProviderRoute("config/providers/route.json", providerDescriptorExists);
  const deps: DashboardDeps = {
    config: {
      listenEnv: "MOC_DASHBOARD_LISTEN",
      listenAlias: "dashboard",
      logPath: "logs/dashboard.jsonl",
      maxRequestBytes: 1024,
      idleTimeoutSec: 10,
      workRowLimit: 50,
      baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null },
    },
    listen: { host: "127.0.0.1", port: 0 },
    fixed: {
      budget,
      route,
      baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null },
      workRowLimit: 50,
      logPath: "logs/dashboard.jsonl",
    },
    sources: {
      ledgerPath: "tests/fixtures/dashboard/ledger.jsonl",
      verdictDir: "tests/fixtures/dashboard/verdicts",
      hostState: null,
      registryPath: "",
    },
    now: () => new Date("2026-10-27T12:00:00.000Z"),
    log: (event) => {
      logged.push(event);
    },
  };
  const server = await startDashboard(deps);
  servers.push(server);
  return { port: server.port };
}

describe("dashboard http (mutation: Host allowlist removed or checked after routing)", () => {
  test("wrong Host gets 421 and learns nothing", async () => {
    const logged: DashboardLogEvent[] = [];
    const { port } = await startTestServer(logged);
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      headers: { host: "evil.example:80" },
    });
    expect(response.status).toBe(421);
    expect(await response.text()).not.toContain("Means of Compute");
  });

  test("HEAD gets 405 with an allow header (mutation: HEAD renders the page)", async () => {
    const logged: DashboardLogEvent[] = [];
    const { port } = await startTestServer(logged);
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      method: "HEAD",
      headers: { host: `127.0.0.1:${String(port)}` },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await response.text()).not.toContain("Means of Compute");
  });

  test("unknown path gets 404 (mutation: router serves every path)", async () => {
    const logged: DashboardLogEvent[] = [];
    const { port } = await startTestServer(logged);
    const response = await fetch(`http://127.0.0.1:${String(port)}/nope`, {
      headers: { host: `127.0.0.1:${String(port)}` },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Means of Compute");
  });

  test("GET / returns 200 with security headers and all panels", async () => {
    const logged: DashboardLogEvent[] = [];
    const { port } = await startTestServer(logged);
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      headers: { host: `localhost:${String(port)}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy") ?? "").toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy") ?? "").toContain("style-src 'sha256-");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const page = await response.text();
    for (const title of ["Fleet", "Work", "Usage", "Savings", "Autonomy"]) {
      expect(page).toContain(title);
    }
    const requests = logged.filter((event) => event.event === "request");
    expect(requests.length).toBe(1);
    expect(requests[0]?.bytes).toBeGreaterThan(0);
  });

  test("query string is ignored and the page stays 200", async () => {
    const logged: DashboardLogEvent[] = [];
    const { port } = await startTestServer(logged);
    const response = await fetch(`http://127.0.0.1:${String(port)}/?x=1`, {
      headers: { host: `127.0.0.1:${String(port)}` },
    });
    expect(response.status).toBe(200);
    await response.text();
  });
});
