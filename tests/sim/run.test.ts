/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
    expect(createHash("sha256").update(a).digest("hex")).toBe(
      "934478698a2667061cf970e4a6678828b9a5ccc918b3f52e170f7ac86b361224",
    );
    const lines = linesA as unknown as Record<string, unknown>[];
    const header = lines[0] as Record<string, unknown>;
    expect(header["kind"]).toBe("header");
    expect(header["hostCount"]).toBe(300);
    expect(header["schemaVersion"]).toBe("sim-trace-v1");
    const placements = lines.filter((l) => l["kind"] === "placement") as Record<string, unknown>[];
    expect(placements.length).toBe(315);
    const first = placements[0] as Record<string, unknown>;
    expect(first["chosenHostAlias"]).toBe("desk-085");
    expect(first["reason"]).toBe(
      "desk-085 is idle, on AC power, no battery, CPU 93% free, memory 71% free, inside its policy window, 0/2 agents running",
    );
    const candidates = first["candidates"] as unknown[];
    expect(Array.isArray(candidates)).toBe(true);
    const eligibleCount = first["eligibleCount"] as number;
    expect(eligibleCount).toBeGreaterThan(0);
    expect(
      linesA.every((l) => (l as unknown as Record<string, unknown>)["simulated"] === true),
    ).toBe(true);
    const runningHost = lines.find(
      (l) => l["kind"] === "host" && l["state"] === "running" && (l["running"] as number) >= 1,
    );
    expect(runningHost).toBeDefined();
    const atLimitHost = lines.find(
      (l) =>
        l["kind"] === "host" &&
        l["eligible"] === false &&
        String(l["excludeReason"]).includes("at agent limit"),
    );
    expect(atLimitHost).toBeDefined();
    const truth = new Map<string, number>();
    const last = new Map<string, Record<string, unknown>>();
    let currentMinute = -1;
    function flushMinute(): void {
      if (currentMinute === -1) {
        return;
      }
      for (const [alias, hostLine] of last) {
        const expected = truth.get(alias) ?? 0;
        expect(hostLine["running"]).toBe(expected);
        if ((hostLine["running"] as number) === (hostLine["maxAgents"] as number)) {
          expect(hostLine["eligible"]).toBe(false);
        }
      }
    }
    for (const line of lines) {
      const atMinute = line["atMinute"] as number | undefined;
      if (atMinute !== undefined && atMinute !== currentMinute) {
        // flush previous minute before advancing
        if (currentMinute !== -1) {
          flushMinute();
        }
        currentMinute = atMinute;
      }
      if (line["kind"] === "placement") {
        const chosen = line["chosenHostAlias"] as string | null;
        if (chosen !== null) {
          truth.set(chosen, (truth.get(chosen) ?? 0) + 1);
        }
      } else if (line["kind"] === "work-end") {
        const hostAlias = line["hostAlias"] as string;
        truth.set(hostAlias, (truth.get(hostAlias) ?? 0) - 1);
      } else if (line["kind"] === "host") {
        last.set(String(line["alias"]), line);
      }
    }
    flushMinute();
    // also verify every host's last line matches truth
    for (const [alias, expected] of truth) {
      const hostLine = last.get(alias);
      if (hostLine !== undefined) {
        expect(hostLine["running"]).toBe(expected);
      }
    }
    const tasksByPrefix: Record<string, readonly { kind: string; title: string }[]> = {
      "sim-w-": [
        { kind: "code", title: "Code change {n}" },
        { kind: "support", title: "Support queue triage {n}" },
        { kind: "research", title: "Supplier research {n}" },
        { kind: "support", title: "Support queue triage {n}" },
      ],
      "sim-x-": [
        { kind: "research", title: "Supplier research {n}" },
        { kind: "code", title: "Code change {n}" },
        { kind: "research", title: "Supplier research {n}" },
        { kind: "support", title: "Support queue triage {n}" },
      ],
      "sim-y-": [
        { kind: "data-analysis", title: "Sales data analysis {n}" },
        { kind: "code", title: "Code change {n}" },
        { kind: "data-analysis", title: "Sales data analysis {n}" },
        { kind: "support", title: "Support queue triage {n}" },
      ],
      "sim-z-": [
        { kind: "data-analysis", title: "Sales data analysis {n}" },
        { kind: "code", title: "Code change {n}" },
        { kind: "support", title: "Support queue triage {n}" },
        { kind: "data-analysis", title: "Sales data analysis {n}" },
      ],
    };
    const titlePrefixByKind: Record<string, string> = {
      support: "Support queue triage ",
      research: "Supplier research ",
      "data-analysis": "Sales data analysis ",
      code: "Code change ",
    };
    for (const placement of placements) {
      const workItemId = placement["workItemId"] as string;
      const prefix = Object.keys(tasksByPrefix).find((p) => workItemId.startsWith(p));
      expect(prefix).toBeDefined();
      const num = Number(workItemId.split("-").pop());
      const tasks = tasksByPrefix[prefix as string] as readonly { kind: string; title: string }[];
      const expected = tasks[(num - 1) % tasks.length] as { kind: string; title: string };
      const task = placement["task"] as unknown as { kind: string; title: string } | null;
      expect(task).not.toBeNull();
      expect(task?.kind).toBe(expected.kind);
      const prefixTitle = titlePrefixByKind[expected.kind] as string;
      const expectedTitle = `${prefixTitle}${String(num).padStart(3, "0")}`;
      expect(task?.title).toBe(expectedTitle);
      expect(task?.title.includes("{n}")).toBe(false);
    }
    const runningLine = lines.find(
      (l) =>
        l["kind"] === "host" && l["alias"] === first["chosenHostAlias"] && l["atMinute"] === 15,
    ) as Record<string, unknown> | undefined;
    expect(runningLine).toBeDefined();
    const runningTask = runningLine?.["task"] as unknown as { kind: string; title: string } | null;
    const firstTask = (first as Record<string, unknown>)["task"] as unknown as {
      kind: string;
      title: string;
    } | null;
    expect(runningTask).toEqual(firstTask);
    const stripped = linesA.map((l) => {
      const rec = l as unknown as Record<string, unknown>;
      if (rec["kind"] === "placement" || rec["kind"] === "host") {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { task: _task, ...rest } = rec;
        return rest;
      }
      return rec;
    });
    expect(stripped.every((r) => !("task" in r))).toBe(true);
    expect(
      createHash("sha256")
        .update(stripped.map((r) => JSON.stringify(r)).join("\n") + "\n")
        .digest("hex"),
    ).toBe("0b465d78ad29f2be59d3a0717efa1f92733f881c818deaa25966ec00d2004cf9");
    const runningByHost = new Map<
      string,
      { atMinute: number; task: { kind: string; title: string } }[]
    >();
    const workDuration = new Map<string, number>();
    for (const workItemId of placements.map((p) => p["workItemId"] as string)) {
      const prefix = Object.keys(tasksByPrefix).find((p) => workItemId.startsWith(p)) as string;
      const duration = prefix === "sim-w-" ? 50 : 120;
      workDuration.set(workItemId, duration);
    }
    for (const line of lines) {
      if (line["kind"] === "placement") {
        const chosen = line["chosenHostAlias"] as string | null;
        if (chosen !== null) {
          const list = runningByHost.get(chosen) ?? [];
          list.push({
            atMinute: line["atMinute"] as number,
            task: line["task"] as { kind: string; title: string },
          });
          runningByHost.set(chosen, list);
        }
      } else if (line["kind"] === "work-end") {
        const hostAlias = line["hostAlias"] as string;
        const workItemId = line["workItemId"] as string;
        const list = runningByHost.get(hostAlias);
        if (list !== undefined) {
          const idx = list.findIndex((entry) =>
            entry.task.title.endsWith(workItemId.split("-").pop() as string),
          );
          if (idx !== -1) {
            list.splice(idx, 1);
          }
        }
      }
    }
    // Direct check: find a host line with running >=2 where tasks differ, and verify earliest task
    let foundEarliest = false;
    const active = new Map<
      string,
      { atMinute: number; task: { kind: string; title: string }; workItemId: string }[]
    >();
    for (const line of lines) {
      if (line["kind"] === "placement") {
        const chosen = line["chosenHostAlias"] as string | null;
        if (chosen !== null) {
          const list = active.get(chosen) ?? [];
          list.push({
            atMinute: line["atMinute"] as number,
            task: line["task"] as { kind: string; title: string },
            workItemId: line["workItemId"] as string,
          });
          active.set(chosen, list);
        }
      } else if (line["kind"] === "work-end") {
        const hostAlias = line["hostAlias"] as string;
        const workItemId = line["workItemId"] as string;
        const list = active.get(hostAlias);
        if (list !== undefined) {
          const idx = list.findIndex((entry) => entry.workItemId === workItemId);
          if (idx !== -1) {
            list.splice(idx, 1);
          }
        }
      } else if (line["kind"] === "host" && (line["running"] as number) >= 2) {
        const alias = String(line["alias"]);
        const list = active.get(alias) ?? [];
        if (list.length >= 2) {
          const sorted = [...list].sort((a, b) => a.atMinute - b.atMinute);
          if (sorted[0]?.task.kind !== sorted[1]?.task.kind) {
            const hostTask = line["task"] as { kind: string; title: string } | null;
            const firstTask = sorted[0] as (typeof sorted)[number] | undefined;
            if (firstTask === undefined) {
              continue;
            }
            expect(hostTask).toEqual(firstTask.task);
            foundEarliest = true;
            break;
          }
        }
      }
    }
    expect(foundEarliest).toBe(true);
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

  test("an unknown event key exits 2 naming the field, and a run writes no file other than --out", () => {
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
      const outBad = join(dir, "out.jsonl");
      const proc = Bun.spawnSync(
        ["bun", "run", "src/sim/cli.ts", "--timeline", badTimelinePath, "--out", outBad],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(proc.exitCode).toBe(2);
      const stderr = proc.stderr.toString();
      expect(stderr).toContain("events[0]");
      expect(stderr).toContain("extraKey");
      let outExists = false;
      try {
        readFileSync(outBad, "utf8");
        outExists = true;
      } catch {
        outExists = false;
      }
      expect(outExists).toBe(false);
      const out = join(dir, "out.jsonl");
      const proc2 = Bun.spawnSync(
        ["bun", "run", "src/sim/cli.ts", "--timeline", "config/sim/evening-300.json", "--out", out],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(proc2.exitCode).toBe(0);
      const entries = readdirSync(dir);
      expect(entries.sort()).toEqual(["bad.json", "out.jsonl"].sort());
      const simSources = [
        readFileSync("src/sim/timeline.ts", "utf8"),
        readFileSync("src/sim/run.ts", "utf8"),
        readFileSync("src/sim/cli.ts", "utf8"),
      ].join("\n");
      expect(simSources).not.toContain("ledger");
      expect(simSources).not.toContain("meter");
      expect(simSources).not.toContain("registry");
      const base2 = JSON.parse(readFileSync("config/sim/evening-300.json", "utf8")) as Record<
        string,
        unknown
      >;
      const withoutTasks = structuredClone(base2) as Record<string, unknown>;
      const workWithout = (withoutTasks["work"] as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >;
      delete workWithout["tasks"];
      const withoutPath = join(dir, "without-tasks.json");
      const outWithout = join(dir, "out-without.jsonl");
      writeFileSync(withoutPath, JSON.stringify(withoutTasks));
      const procWithout = Bun.spawnSync(
        ["bun", "run", "src/sim/cli.ts", "--timeline", withoutPath, "--out", outWithout],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(procWithout.exitCode).toBe(2);
      expect(procWithout.stderr.toString()).toContain("work[0]");
      expect(procWithout.stderr.toString()).toContain("tasks");
      const longTitle: Record<string, unknown> = {
        schemaVersion: "sim-v1",
        name: "test-long",
        seed: 1,
        startAt: "2026-11-03T17:00:00.000Z",
        durationMinutes: 1440,
        speed: 60,
        kinds: {
          desk: {
            cores: 8,
            memoryTotalMb: 32768,
            gpuPresent: false,
            battery: "none",
            maxConcurrentAgents: 2,
            allowedWindow: { start: "00:00", end: "00:00" },
            startsIdle: false,
          },
        },
        generators: [{ kind: "desk", count: 1, aliasPrefix: "desk-", site: "hq-floor-2" }],
        waves: [],
        events: [],
        work: [
          {
            firstAtMinute: 0,
            everyMinutes: 1,
            count: 1000,
            durationMinutes: 50,
            idPrefix: "sim-w-",
            tasks: [{ kind: "code", title: `${"a".repeat(57)}{n}` }],
          },
        ],
      };
      const longPath = join(dir, "long-title.json");
      const outLong = join(dir, "out-long.jsonl");
      writeFileSync(longPath, JSON.stringify(longTitle));
      const procLong = Bun.spawnSync(
        ["bun", "run", "src/sim/cli.ts", "--timeline", longPath, "--out", outLong],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(procLong.exitCode).toBe(2);
      expect(procLong.stderr.toString()).toContain("work[0].tasks[0].title");
      const badKind = structuredClone(base2) as Record<string, unknown>;
      const workBad = (badKind["work"] as Record<string, unknown>[])[0] as Record<string, unknown>;
      ((workBad["tasks"] as Record<string, unknown>[])[0] as Record<string, unknown>)["kind"] =
        "unknown-kind";
      const badKindPath = join(dir, "bad-kind.json");
      const outBadKind = join(dir, "out-bad-kind.jsonl");
      writeFileSync(badKindPath, JSON.stringify(badKind));
      const procBadKind = Bun.spawnSync(
        ["bun", "run", "src/sim/cli.ts", "--timeline", badKindPath, "--out", outBadKind],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(procBadKind.exitCode).toBe(2);
      expect(procBadKind.stderr.toString()).toContain("work[0].tasks[0].kind");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
