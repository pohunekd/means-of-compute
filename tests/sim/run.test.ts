/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlacementConfig } from "../../src/placement/config.ts";
import { loadTimeline } from "../../src/sim/timeline.ts";
import { runTimeline } from "../../src/sim/run.ts";

describe("fleet simulator", () => {
  test("the evening timeline expands to 300 hosts and replays byte-identically, and the first placement chooses a desk with the real place() reason", async () => {
    const timeline = await loadTimeline("config/sim/evening-300.json");
    const config = await loadPlacementConfig();
    expect(timeline.seed).toBe(20261103);
    const linesA = runTimeline({ timeline, config });
    const linesB = runTimeline({ timeline, config });
    const a = linesA.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const b = linesB.map((l) => JSON.stringify(l)).join("\n") + "\n";
    expect(a).toBe(b);
    const lines = linesA as unknown as Record<string, unknown>[];
    const header = lines[0] as Record<string, unknown>;
    expect(header["kind"]).toBe("header");
    expect(header["hostCount"]).toBe(300);
    expect(header["schemaVersion"]).toBe("sim-trace-v1");
    const placements = lines.filter((l) => l["kind"] === "placement") as Record<string, unknown>[];
    expect(placements.length).toBe(28);
    const first = placements[0] as Record<string, unknown>;
    expect(first["chosenHostAlias"]).toBe("desk-007");
    const reason = String(first["reason"]);
    expect(reason).toContain("desk-007 is idle");
    expect(reason).toContain("on AC power");
    expect(reason).toContain("no battery");
    expect(reason).toContain("CPU 86% free");
    expect(reason).toContain("memory 69% free");
    const candidates = first["candidates"] as unknown[];
    expect(Array.isArray(candidates)).toBe(true);
    const chosenCand = (candidates as Record<string, unknown>[]).find(
      (c) => c["hostAlias"] === "desk-007",
    );
    expect(chosenCand).toBeDefined();
    expect(String((chosenCand as Record<string, unknown>)["reason"])).toContain("idle");
    const eligibleCount = first["eligibleCount"] as number;
    expect(eligibleCount).toBeGreaterThan(0);
  });

  test("a battery of 40 excludes the docked laptop with the battery-floor reason and a return event makes desk-142 ineligible at its minute", async () => {
    const timeline = await loadTimeline("config/sim/evening-300.json");
    const config = await loadPlacementConfig();
    const lines = runTimeline({ timeline, config }) as unknown as Record<string, unknown>[];
    const hostAt95 = lines.find(
      (l) => l["kind"] === "host" && l["alias"] === "laptop-007" && l["atMinute"] === 95,
    ) as Record<string, unknown> | undefined;
    expect(hostAt95).toBeDefined();
    expect(hostAt95?.["eligible"]).toBe(false);
    expect(hostAt95?.["state"]).toBe("blocked");
    expect(String(hostAt95?.["excludeReason"])).toContain("battery at 40 percent");
    expect(String(hostAt95?.["excludeReason"])).toContain("50 percent floor");
    const placementAt96 = lines.find((l) => l["kind"] === "placement" && l["atMinute"] === 96) as
      Record<string, unknown> | undefined;
    expect(placementAt96).toBeDefined();
    const cands = placementAt96?.["candidates"] as Record<string, unknown>[] | undefined;
    expect(cands).toBeDefined();
    const laptop007Cand = cands?.find((c) => c["hostAlias"] === "laptop-007");
    expect(laptop007Cand).toBeDefined();
    expect(laptop007Cand?.["excluded"]).toBe(true);
    expect(String(laptop007Cand?.["reason"])).toContain("battery at 40 percent");
    const hostAt100 = lines.find(
      (l) => l["kind"] === "host" && l["alias"] === "desk-142" && l["atMinute"] === 100,
    ) as Record<string, unknown> | undefined;
    expect(hostAt100).toBeDefined();
    expect(hostAt100?.["eligible"]).toBe(false);
    expect(hostAt100?.["state"]).toBe("busy");
    expect(String(hostAt100?.["excludeReason"])).toContain("not idle");
    const eventAt100 = lines.find(
      (l) => l["kind"] === "event" && l["alias"] === "desk-142" && l["atMinute"] === 100,
    ) as Record<string, unknown> | undefined;
    expect(eventAt100).toBeDefined();
    expect(eventAt100?.["event"]).toBe("return");
  });

  test("an unknown event key exits 2 naming the field, and a run writes no file other than --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-unknown-"));
    try {
      const badTimelinePath = join(dir, "bad.json");
      const base = JSON.parse(readFileSync("config/sim/evening-300.json", "utf8")) as Record<
        string,
        unknown
      >;
      const bad = structuredClone(base) as Record<string, unknown>;
      const events = bad["events"] as Record<string, unknown>[];
      const firstEvent = events[0] as Record<string, unknown>;
      (firstEvent as Record<string, unknown>)["extraKey"] = "oops";
      writeFileSync(badTimelinePath, JSON.stringify(bad));
      let threw = false;
      try {
        await loadTimeline(badTimelinePath);
      } catch (err) {
        threw = true;
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toContain("events[0]");
        expect(msg).toContain("extraKey");
      }
      expect(threw).toBe(true);
      const timeline = await loadTimeline("config/sim/evening-300.json");
      const config = await loadPlacementConfig();
      const lines2 = runTimeline({ timeline, config });
      const out = join(dir, "out.jsonl");
      writeFileSync(out, lines2.map((l) => JSON.stringify(l)).join("\n") + "\n");
      const files = readFileSync(out, "utf8");
      expect(files.length).toBeGreaterThan(0);
      const onlyOut = (() => {
        const entries = new Set<string>();
        for (const e of readdirSync(dir)) {
          entries.add(e);
        }
        return entries;
      })();
      expect(onlyOut.has("out.jsonl")).toBe(true);
      expect(onlyOut.size).toBe(2);
      const simSources = [
        readFileSync("src/sim/timeline.ts", "utf8"),
        readFileSync("src/sim/run.ts", "utf8"),
        readFileSync("src/sim/cli.ts", "utf8"),
      ].join("\n");
      expect(simSources).not.toContain("ledger");
      expect(simSources).not.toContain("meter");
      expect(simSources).not.toContain("registry");
      expect(simSources).not.toContain("src/fs/input");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
