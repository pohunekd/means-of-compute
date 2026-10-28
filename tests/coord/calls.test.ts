// Coordinator call-log tests (L1-L5): filtering, invalid lines, absent and
// unreadable paths.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordCallEnd } from "../../src/coord/calls.js";
import { COORDINATOR_CALLER, RunCallsDataError, readCoordCalls } from "../../src/coord/calls.js";

const SERVER_START =
  '{"ts":"2026-10-28T10:00:00.000Z","event":"server-start","run":"11111111-1111-4111-8111-111111111111","caller":"coordinator","pid":4242}';
const COORD_CALL_END =
  '{"ts":"2026-10-28T10:00:00.026Z","event":"call-end","run":"11111111-1111-4111-8111-111111111111","callId":1,"caller":"coordinator","tool":"submit_work","class":"write","outcome":"ok","code":null,"durationMs":6,"summary":{"submissionId":"sub-db8733fb616884a9","itemIds":["greet-parser","greet-render","greet-cli"],"replayed":false},"detail":null}';
const SESSION_INIT =
  '{"ts":"2026-10-28T10:00:00.010Z","event":"session-init","run":"11111111-1111-4111-8111-111111111111","caller":"coordinator","client":{"name":"example-client","version":"0.0.0"},"protocolVersion":"2025-11-25"}';
const CALL_START =
  '{"ts":"2026-10-28T10:00:00.020Z","event":"call-start","run":"11111111-1111-4111-8111-111111111111","callId":1,"caller":"coordinator","client":{"name":"example-client","version":"0.0.0"},"tool":"submit_work","class":"write","argsSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","argsBytes":1234}';
const SERVER_STOP =
  '{"ts":"2026-10-28T10:00:01.000Z","event":"server-stop","run":"11111111-1111-4111-8111-111111111111","reason":"eof"}';
const OTHER_CALL_END =
  '{"ts":"2026-10-28T10:00:02.010Z","event":"call-end","run":"22222222-2222-4222-8222-222222222222","callId":1,"caller":"mcp-call","tool":"list_work","class":"read","outcome":"refused","code":"invalid-arguments","durationMs":2,"summary":null,"detail":null}';
const OTHER_SERVER_START =
  '{"ts":"2026-10-28T10:00:02.000Z","event":"server-start","run":"22222222-2222-4222-8222-222222222222","caller":"mcp-call","pid":4243}';

test("coordinator call-ends survive filtering with a torn tail (L1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-calls-"));
  try {
    const path = join(dir, "calls.jsonl");
    const lines = [
      SERVER_START,
      SESSION_INIT,
      CALL_START,
      COORD_CALL_END,
      SERVER_STOP,
      OTHER_SERVER_START,
      OTHER_CALL_END,
    ];
    await Bun.write(path, `${lines.join("\n")}\n{"ts":"2026-10-28T10:00:03.000Z","event":"call-`);
    const result = await readCoordCalls(path);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(1);
    expect(result?.[0]).toEqual(JSON.parse(COORD_CALL_END) as CoordCallEnd);
    expect(result?.[0]?.caller).toBe(COORDINATOR_CALLER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-JSON line names its line number (L2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-calls-"));
  try {
    const path = join(dir, "calls.jsonl");
    await Bun.write(path, `${SERVER_START}\nnot json\n${COORD_CALL_END}\n`);
    let error: unknown;
    try {
      await readCoordCalls(path);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RunCallsDataError);
    expect((error as Error).message).toBe(
      `Run calls ${path}: line 2 is not a JSON object with a string event`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a call-end with a mistyped callId is invalid (L3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-calls-"));
  try {
    const path = join(dir, "calls.jsonl");
    const parsed = JSON.parse(COORD_CALL_END) as Record<string, unknown>;
    parsed["callId"] = "1";
    await Bun.write(path, `${JSON.stringify(parsed)}\n`);
    let error: unknown;
    try {
      await readCoordCalls(path);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RunCallsDataError);
    expect((error as Error).message).toBe(`Run calls ${path}: line 1 is not a valid call-end`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent log returns null (L4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-calls-"));
  try {
    const result = await readCoordCalls(join(dir, "absent.jsonl"));
    expect(result).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory path wraps once without duplicating the path (L5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-calls-"));
  try {
    let error: unknown;
    try {
      await readCoordCalls(dir);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RunCallsDataError);
    const message = (error as Error).message;
    expect(message.startsWith(`Run calls ${dir}: `)).toBe(true);
    expect(message.split(dir).length).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
