import { describe, expect, test } from "bun:test";
import { runThenClose } from "../../src/dispatcher/run-then-close.js";

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("runThenClose", () => {
  test("a close failure warns and the run value is still returned", async () => {
    const lines: string[] = [];
    const calls: string[] = [];
    const value = await runThenClose(
      () => Promise.resolve("ok"),
      [
        {
          name: "meter",
          close: () => Promise.reject(new Error("boom")),
        },
        {
          name: "port",
          close: async () => {
            calls.push("port");
          },
        },
      ],
      (line) => {
        lines.push(line);
      },
    );
    expect(value).toBe("ok");
    expect(calls).toEqual(["port"]);
    expect(lines).toEqual(["dispatch: close meter: failed"]);
  });

  test("a close failure does not replace the run error", async () => {
    const lines: string[] = [];
    const runError = new Error("run failed");
    const seen = await runThenClose(
      () => Promise.reject(runError),
      [
        {
          name: "port",
          close: () => Promise.reject(errnoError("EIO")),
        },
      ],
      (line) => {
        lines.push(line);
      },
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(seen).toBe(runError);
    expect(lines).toEqual(["dispatch: close port: EIO"]);
  });

  test("successful closers warn nothing", async () => {
    const lines: string[] = [];
    const value = await runThenClose(
      () => Promise.resolve(7),
      [
        {
          name: "meter",
          close: () => Promise.resolve(),
        },
        {
          name: "port",
          close: () => Promise.resolve(),
        },
      ],
      (line) => {
        lines.push(line);
      },
    );
    expect(value).toBe(7);
    expect(lines).toEqual([]);
  });
});
