// Coordinator report tests (R1-R7): fixed render, strand propagation,
// snapshot failure, followup and out-of-scope ids, snapshot parsing.
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { CoordCallEnd } from "../../src/coord/calls.js";
import {
  buildReport,
  parseListSnapshot,
  ReportDataError,
  renderReportMd,
  strandedIds,
  type ListRow,
  type ReportInput,
} from "../../src/coord/report.js";

const SHA_C = "c".repeat(64);

function row(overrides: Partial<ListRow> & { readonly id: string }): ListRow {
  return {
    status: "queued",
    statusReason: null,
    pullNumber: null,
    dependencies: [],
    dod: { done: 0, total: 1 },
    retryCount: 0,
    ...overrides,
  };
}

function callEnd(overrides: Partial<CoordCallEnd> & { readonly tool: string }): CoordCallEnd {
  return {
    ts: "2026-10-28T10:01:00.000Z",
    event: "call-end",
    run: "20261028T100000Z-notes-abcdef",
    callId: 1,
    caller: "coordinator",
    class: "write",
    outcome: "ok",
    code: null,
    durationMs: 5,
    summary: null,
    detail: null,
    ...overrides,
  };
}

function fixedInput(): ReportInput {
  return {
    runId: "20261028T100000Z-notes-abcdef",
    goalId: "notes",
    idPrefix: "notes",
    repo: "example/demo-repo",
    phase: "full",
    stop: "goal-terminal",
    startedAt: "2026-10-28T10:00:00.000Z",
    endedAt: "2026-10-28T10:04:30.500Z",
    configPath: "config/coordinator.json",
    configSha256: SHA_C,
    gates: [
      { k: 1, admit: true, reason: null },
      { k: 2, admit: true, reason: null },
    ],
    sessions: [
      {
        k: 1,
        kind: "plan",
        sessionId: "0b7e6f52-3c1d-4e8a-9f20-6a5d4c3b2a19",
        outcome: { kind: "exited", rc: 0 },
        durationMs: 245300,
        exportOk: true,
        attentionKeys: [],
      },
      {
        k: 2,
        kind: "react",
        sessionId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        outcome: { kind: "exited", rc: 0 },
        durationMs: 61000,
        exportOk: false,
        attentionKeys: ["followup:notes-store"],
      },
    ],
    calls: [
      callEnd({
        callId: 1,
        tool: "submit_work",
        class: "write",
        outcome: "ok",
        summary: {
          submissionId: "sub-db8733fb616884a9",
          itemIds: ["notes-parse", "notes-store", "notes-cli"],
          replayed: false,
        },
      }),
      callEnd({
        callId: 2,
        tool: "submit_work",
        class: "write",
        outcome: "refused",
        code: "dag-cycle",
        summary: null,
      }),
      callEnd({
        callId: 3,
        tool: "submit_work",
        class: "write",
        outcome: "refused",
        code: "dag-cycle",
        summary: null,
      }),
    ],
    consumed: ["followup:notes-store"],
    finalSnapshot: {
      ok: true,
      snapshot: {
        revision: 3,
        items: [
          row({ id: "notes-parse", status: "queued" }),
          row({
            id: "notes-store",
            status: "blocked",
            statusReason: "blocked: 2 retries used",
            pullNumber: 7,
            dod: { done: 0, total: 2 },
            retryCount: 2,
          }),
          row({ id: "notes-cli", status: "queued", dependencies: ["notes-store"] }),
        ],
      },
    },
  };
}

function minimalInput(overrides: Partial<ReportInput>): ReportInput {
  return {
    runId: "20261028T100000Z-notes-abcdef",
    goalId: "notes",
    idPrefix: "notes",
    repo: "example/demo-repo",
    phase: "full",
    stop: "goal-terminal",
    startedAt: "2026-10-28T10:00:00.000Z",
    endedAt: "2026-10-28T10:04:30.500Z",
    configPath: "config/coordinator.json",
    configSha256: SHA_C,
    gates: [],
    sessions: [],
    calls: [],
    consumed: [],
    finalSnapshot: { ok: true, snapshot: { revision: 1, items: [] } },
    ...overrides,
  };
}

test("the fixed report renders the committed bytes (R1)", async () => {
  const rendered = renderReportMd(buildReport(fixedInput()));
  const expected = await Bun.file(
    join(process.cwd(), "tests", "fixtures", "coord", "report-expected.md"),
  ).text();
  expect(rendered).toBe(expected);
});

test("stranding propagates through queued chains and operator parks (R2)", () => {
  const rows = [
    row({ id: "a", status: "blocked" }),
    row({ id: "b", dependencies: ["a"] }),
    row({ id: "c", dependencies: ["b"] }),
    row({ id: "d" }),
    row({ id: "p", status: "parked", statusReason: "operator: pull-closed" }),
    row({ id: "e", dependencies: ["p"] }),
    row({ id: "q", status: "parked", statusReason: "session lost" }),
    row({ id: "f", dependencies: ["q"] }),
  ];
  expect([...strandedIds(rows)].sort()).toEqual(["b", "c", "e"]);
});

test("a failed snapshot nulls items and reports the code (R3)", () => {
  const input = minimalInput({ finalSnapshot: { ok: false, code: "source-unreadable" } });
  const report = buildReport(input);
  expect(report.items).toBeNull();
  expect(report.unresolved).toBeNull();
  const rendered = renderReportMd(report);
  expect(rendered.includes("Items: unavailable (source-unreadable)")).toBe(true);
  expect(rendered.includes("Unresolved: unavailable (source-unreadable)")).toBe(true);
});

test("followups dedupe and out-of-scope ids split by prefix (R4)", () => {
  const replayed = (value: boolean): CoordCallEnd =>
    callEnd({
      callId: value ? 2 : 1,
      tool: "submit_work",
      class: "write",
      outcome: "ok",
      summary: {
        submissionId: "sub-1111111111111111",
        itemIds: ["notes-a", "notes-b-fu", "other-x"],
        replayed: value,
      },
    });
  const input = minimalInput({
    calls: [
      replayed(false),
      replayed(true),
      callEnd({
        callId: 3,
        tool: "submit_work",
        class: "write",
        outcome: "refused",
        code: "dag-cycle",
        summary: null,
      }),
    ],
  });
  const report = buildReport(input);
  expect(report.calls["submit_work"]).toEqual({ ok: 2, refused: 1, error: 0 });
  expect(report.calls["fleet_status"]).toEqual({ ok: 0, refused: 0, error: 0 });
  expect(report.calls["list_work"]).toEqual({ ok: 0, refused: 0, error: 0 });
  expect(report.calls["audit_results"]).toEqual({ ok: 0, refused: 0, error: 0 });
  expect(report.calls["approve"]).toEqual({ ok: 0, refused: 0, error: 0 });
  expect(report.calls["pause_fleet"]).toEqual({ ok: 0, refused: 0, error: 0 });
  expect(report.followups).toEqual(["notes-b-fu"]);
  expect(report.outOfScope).toEqual(["other-x"]);
});

test("only unresolved followup keys survive the snapshot (R5)", () => {
  const input = minimalInput({
    consumed: ["followup:notes-b", "followup:notes-c", "pause:notes"],
    finalSnapshot: { ok: true, snapshot: { revision: 1, items: [row({ id: "notes-b-fu" })] } },
  });
  expect(buildReport(input).unresolved).toEqual(["followup:notes-c"]);
});

test("snapshot parsing accepts the captured shapes (R6)", () => {
  const okPayload = {
    ok: true,
    revision: 1,
    items: [
      {
        id: "greet-parser",
        repo: "example/demo-repo",
        title: "Parse greeting templates",
        issue: null,
        status: "queued",
        statusReason: null,
        assignedHostAlias: null,
        branch: null,
        pullNumber: null,
        dependencies: [],
        dod: { done: 0, total: 1 },
        retryCount: 0,
        stallRounds: 0,
        modelRouting: {
          preferredModel: "meta/muse-glimmer-30b",
          attempts: 0,
          fallbackUsed: false,
        },
      },
    ],
  };
  const parsed = parseListSnapshot(okPayload);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.snapshot.revision).toBe(1);
    expect(parsed.snapshot.items.map((item) => item.id)).toEqual(["greet-parser"]);
  }
  expect(
    parseListSnapshot({
      ok: false,
      error: {
        code: "invalid-arguments",
        message: "invalid arguments at / (required)",
        retryable: false,
        path: "/",
        keyword: "required",
      },
    }),
  ).toEqual({ ok: false, code: "invalid-arguments" });
  const withoutDeps = structuredClone(okPayload) as {
    readonly items: readonly Record<string, unknown>[];
  };
  const rowShape = { ...withoutDeps.items[0] };
  delete rowShape["dependencies"];
  expect(parseListSnapshot({ ok: true, revision: 1, items: [rowShape] })).toEqual({
    ok: false,
    code: "invalid-list-work",
  });
});

test("an ok approve summary lands in requests, a refused line without a code throws (R7, R9)", () => {
  const input = minimalInput({
    calls: [
      callEnd({
        tool: "approve",
        class: "sensitive",
        outcome: "ok",
        summary: { requestId: "req-1", outcome: "recorded" },
      }),
    ],
  });
  expect(buildReport(input).requests).toEqual([{ requestId: "req-1", outcome: "recorded" }]);
  const bad = minimalInput({
    calls: [callEnd({ tool: "submit_work", class: "write", outcome: "ok", summary: null })],
  });
  let thrown: unknown = null;
  try {
    buildReport(bad);
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReportDataError);
  const missingCode = minimalInput({
    calls: [
      callEnd({
        tool: "submit_work",
        class: "write",
        outcome: "refused",
        code: null,
        summary: null,
      }),
    ],
  });
  let codeThrown: unknown = null;
  try {
    buildReport(missingCode);
  } catch (error: unknown) {
    codeThrown = error;
  }
  expect(codeThrown).toBeInstanceOf(ReportDataError);
  expect((codeThrown as Error).message).toBe(
    `Report: call ${missingCode.calls[0]?.run}/${String(missingCode.calls[0]?.callId)} has an invalid submit_work summary`,
  );
});

test("a pipe in a refusal code stays inside its cell (R8)", () => {
  const input = minimalInput({
    calls: [
      callEnd({
        tool: "submit_work",
        class: "write",
        outcome: "refused",
        code: "a|b",
        summary: null,
      }),
    ],
  });
  const rendered = renderReportMd(buildReport(input));
  expect(rendered.includes("| submit_work | a\\|b | 1 |")).toBe(true);
  for (const line of rendered.split("\n")) {
    if (line.includes("submit_work") && line.startsWith("|")) {
      expect(line.split("|").length).toBe(6);
    }
  }
});
