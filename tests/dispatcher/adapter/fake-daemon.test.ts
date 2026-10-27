// Fake daemon tests (design 6.1, decisions F2-F4): the fake merges
// set_metadata patches like the daemon, names the 6.1 contract rows, and
// matches the real daemon's session_not_found answers.
import { expect, test } from "bun:test";
import { createFakeDaemon } from "../../../src/dispatcher/adapter/fake-daemon.js";
import { isSessionNotFound, MOC_METADATA } from "../../../src/dispatcher/adapter/map.js";

const START_PARAMS = {
  agent: "moc-worker",
  name: "req-1",
  cols: 200,
  rows: 50,
  project: "means-of-compute",
  branch: "moc/item-1",
  input: "do the thing",
  input_ack_timeout_ms: 8000,
  metadata: {
    [MOC_METADATA.requestId]: "req-1",
    [MOC_METADATA.requestDigest]: "digest-1",
    [MOC_METADATA.start]: "pending",
  },
};

test("set_metadata null deletes the key and keeps the rest", async () => {
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const client = await fake.connector.client("laptop-a");
    const created = (await client.call("session.new", START_PARAMS)) as { id: string };
    await client.call("session.set_metadata", {
      session_id: created.id,
      metadata: { [MOC_METADATA.requestId]: null, [MOC_METADATA.start]: "void" },
    });
    const listed = (await client.call("session.list", {
      filters: [
        {
          key: "metadata_eq",
          value: { key: MOC_METADATA.requestId, value: "req-1" },
        },
      ],
    })) as readonly unknown[];
    expect(listed).toHaveLength(0);
    const voided = (await client.call("session.list", {
      filters: [
        {
          key: "metadata_eq",
          value: { key: MOC_METADATA.start, value: "void" },
        },
      ],
    })) as readonly { id: string }[];
    expect(voided.map((entry) => entry.id)).toEqual([created.id]);
  } finally {
    await fake.connector.close();
  }
});

test("setSession takes exit_code under the 6.1 name", async () => {
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const client = await fake.connector.client("laptop-a");
    const created = (await client.call("session.new", START_PARAMS)) as { id: string };
    fake.setSession("laptop-a", created.id, { state: "done", exit_code: 3 });
    const info = (await client.call("session.inspect", created.id)) as {
      state: string;
      exit_code: number;
    };
    expect(info.state).toBe("done");
    expect(info.exit_code).toBe(3);
  } finally {
    await fake.connector.close();
  }
});

test("a patched activity reaches the empty-queue wait_turn progress", async () => {
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const client = await fake.connector.client("laptop-a");
    const created = (await client.call("session.new", START_PARAMS)) as { id: string };
    fake.setSession("laptop-a", created.id, {
      activity: "idle",
      turn_started_at: "2026-10-27T00:00:00Z",
    });
    const reply = (await client.call("session.wait_turn", {
      session_ids: [created.id],
      until: ["turn_completed", "agent_blocked", "approval_required", "exited"],
      timeout_ms: 1000,
    })) as {
      reason: string;
      progress: readonly {
        session_id: string;
        activity?: string;
        turn_started_at?: string;
      }[];
    };
    expect(reply.reason).toBe("timeout");
    expect(reply.progress).toHaveLength(1);
    expect(reply.progress[0]?.activity).toBe("idle");
    expect(reply.progress[0]?.turn_started_at).toBe("2026-10-27T00:00:00Z");
  } finally {
    await fake.connector.close();
  }
});

test("a default resume session.new reply carries a non-empty worktree commit", async () => {
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const client = await fake.connector.client("laptop-a");
    const created = (await client.call("session.new", {
      ...START_PARAMS,
      branch_source: "remote",
    })) as { worktree_source?: { ref: string; commit: string } };
    expect(created.worktree_source?.commit).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    await fake.connector.close();
  }
});

test("wait_turn, inspect and diff answer session_not_found for unknown ids", async () => {
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const client = await fake.connector.client("laptop-a");
    for (const invoke of [
      () =>
        client.sessionWaitTurn({
          session_ids: ["fake-9"],
          until: ["turn_completed"],
          timeout_ms: 1000,
        }),
      () => client.call("session.inspect", "fake-9"),
      () => client.call("session.diff", { session_id: "fake-9", base: "origin/main" }),
    ]) {
      let caught: unknown;
      try {
        await invoke();
      } catch (error) {
        caught = error;
      }
      expect(isSessionNotFound(caught)).toBe(true);
    }
  } finally {
    await fake.connector.close();
  }
});
