#!/usr/bin/env bun
// Fake gh for the loop port tests. Replies come from $GH_CONFIG_DIR/fake-gh.json;
// calls append to fake-gh-calls.jsonl with argv, env keys, token match and
// body-file content. The token value is never written anywhere.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface Reply {
  readonly match: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly rc: number;
  readonly hang: boolean;
}

interface Config {
  readonly token: string;
  readonly replies: readonly Reply[];
}

function fail(message: string): never {
  process.stderr.write(message);
  process.exit(99);
}

const dir = process.env["GH_CONFIG_DIR"];
if (dir === undefined || dir.length === 0) {
  fail("fake-gh: no config dir\n");
}
const configDir: string = dir;
const argv = process.argv.slice(2);

const raw: string = await readFile(join(configDir, "fake-gh.json"), "utf8").catch(() => {
  fail("fake-gh: no reply file\n");
});
const parsed: unknown = JSON.parse(raw);
if (typeof parsed !== "object" || parsed === null) {
  fail("fake-gh: bad reply file\n");
}
const config = parsed as Config;

let used: number[] = [];
try {
  const text: string = await readFile(join(configDir, "fake-gh-used.json"), "utf8");
  const saved: unknown = JSON.parse(text);
  if (Array.isArray(saved)) {
    used = saved.filter((entry): entry is number => typeof entry === "number");
  }
} catch {
  used = [];
}

function prefixMatches(match: readonly string[], argv: readonly string[]): boolean {
  if (match.length > argv.length) {
    return false;
  }
  return match.every((entry, index) => entry === argv[index]);
}

let bodyFile: string | null = null;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] as string;
  if (arg === "--body-file") {
    const next = argv[index + 1];
    if (next !== undefined) {
      try {
        bodyFile = await readFile(next, "utf8");
      } catch {
        bodyFile = null;
      }
    }
  } else if (arg.startsWith("body=@")) {
    try {
      bodyFile = await readFile(arg.slice("body=@".length), "utf8");
    } catch {
      bodyFile = null;
    }
  }
}

const record = {
  argv,
  envKeys: Object.keys(process.env).sort(),
  tokenMatches: process.env["GH_TOKEN"] === config.token,
  bodyFile,
};
await appendFile(join(configDir, "fake-gh-calls.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

let chosen = -1;
config.replies.forEach((reply, index) => {
  if (chosen !== -1 || used.includes(index) || !prefixMatches(reply.match, argv)) {
    return;
  }
  chosen = index;
});
if (chosen === -1) {
  fail("fake-gh: no reply\n");
}
used.push(chosen);
await writeFile(join(configDir, "fake-gh-used.json"), JSON.stringify(used), "utf8");
const reply = config.replies[chosen] as Reply;
if (reply.hang) {
  await new Promise(() => undefined);
}
process.stdout.write(reply.stdout);
process.stderr.write(reply.stderr);
process.exit(reply.rc);
