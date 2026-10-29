// Tool-surface tests (U1-U7): the default record passes, and each
// misconfiguration fails with its own reason and lists.
import { expect, test } from "bun:test";
import { ALLOWED_CONTEXT_SOURCES, ALLOWED_TOOLS, checkSurface } from "../../src/coord/surface.js";

const SIX_TOOLS = [...ALLOWED_TOOLS];
const SIX_SOURCES = [...ALLOWED_CONTEXT_SOURCES];

interface Overrides {
  readonly mode?: string;
  readonly activeTools?: readonly string[];
  readonly sources?: readonly string[];
  readonly delegationState?: string;
  readonly agents?: readonly string[];
}

function rec(overrides: Overrides = {}): unknown {
  return {
    envelope: {
      payload_type: "runtime.session",
      payload: {
        event: {
          kind: "model_request_configured",
          toolset: {
            active_tools: overrides.activeTools ?? SIX_TOOLS,
            mode: overrides.mode ?? "named",
            source: "settings",
          },
          run_context_messages: (overrides.sources ?? SIX_SOURCES).map((s) => ({ source: s })),
          delegation_posture: { state: overrides.delegationState ?? "inactive" },
          reminder_roster: { agents: overrides.agents ?? [], source: "runtime" },
        },
      },
    },
  };
}

test("the default record passes (U1)", () => {
  expect(checkSurface({ events: [rec()] })).toEqual({ ok: true });
});

test("an extra or missing tool fails the tool check (U2)", () => {
  expect(checkSurface({ events: [rec({ activeTools: [...SIX_TOOLS, "read_file"] })] })).toEqual({
    ok: false,
    reason: "tools",
    extra: ["read_file"],
    missing: [],
  });
  const withoutApprove = SIX_TOOLS.filter((t) => t !== "mcp__factory__approve");
  expect(checkSurface({ events: [rec({ activeTools: withoutApprove })] })).toEqual({
    ok: false,
    reason: "tools",
    extra: [],
    missing: ["mcp__factory__approve"],
  });
});

test("an unknown context source fails the context check (U3)", () => {
  expect(checkSurface({ events: [rec({ sources: [...SIX_SOURCES, "rules_file"] })] })).toEqual({
    ok: false,
    reason: "context",
    extra: ["rules_file"],
    missing: [],
  });
});

test("a non-named toolset fails the mode check (U4)", () => {
  expect(checkSurface({ events: [rec({ mode: "all" })] })).toEqual({
    ok: false,
    reason: "mode",
    extra: [],
    missing: [],
  });
});

test("empty or broken documents are unreadable (U5)", () => {
  for (const doc of [{ events: [] }, {}, { events: [{ envelope: { payload_type: "runtime.session", payload: { event: { kind: "model_request_configured" } } } }] }]) {
    expect(checkSurface(doc)).toEqual({
      ok: false,
      reason: "unreadable",
      extra: [],
      missing: [],
    });
  }
});

test("every record is checked in file order (U6)", () => {
  const bad = rec({ activeTools: [...SIX_TOOLS, "workflow"] });
  expect(checkSurface({ events: [rec(), bad] })).toEqual({
    ok: false,
    reason: "tools",
    extra: ["workflow"],
    missing: [],
  });
});

test("an active posture or roster fails its own check (U7)", () => {
  expect(checkSurface({ events: [rec({ delegationState: "active" })] })).toEqual({
    ok: false,
    reason: "delegation",
    extra: [],
    missing: [],
  });
  expect(checkSurface({ events: [rec({ agents: ["r"] })] })).toEqual({
    ok: false,
    reason: "reminders",
    extra: [],
    missing: [],
  });
});
