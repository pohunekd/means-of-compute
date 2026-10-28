// Host helper: print the meter token stored in the session metadata of
// the calling session. Runs inside the session through the pi agent
// profile; pi sends the printed value as Authorization: Bearer.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import process from "node:process";
import { clearTimeout, setTimeout as setTimer } from "node:timers";

const SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const TIMEOUT_PATTERN = /^[1-9][0-9]*$/;
const TOKEN_PATTERN = /^moc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

function fail(step) {
  process.stderr.write(`meter-token: ${step}\n`);
  process.exit(1);
}

const sessionId = process.env.POHUNEK_SESSION_ID ?? "";
if (sessionId === "") {
  fail("POHUNEK_SESSION_ID is not set");
}
if (!SESSION_PATTERN.test(sessionId)) {
  fail("POHUNEK_SESSION_ID is invalid");
}

const timeoutRaw = process.env.MOC_METER_TOKEN_TIMEOUT_MS ?? "";
if (timeoutRaw === "") {
  fail("MOC_METER_TOKEN_TIMEOUT_MS is not set");
}
if (!TIMEOUT_PATTERN.test(timeoutRaw) || Number(timeoutRaw) > 60000) {
  fail("MOC_METER_TOKEN_TIMEOUT_MS is invalid");
}
const timeoutMs = Number(timeoutRaw);

const child = spawn("pohunek", ["session", "inspect", sessionId, "--json"], {
  stdio: ["ignore", "pipe", "ignore"],
});

const chunks = [];
let finished = false;

const timer = setTimer(() => {
  if (!finished) {
    finished = true;
    child.kill("SIGKILL");
    fail("pohunek timed out");
  }
}, timeoutMs);

child.on("error", () => {
  if (!finished) {
    finished = true;
    clearTimeout(timer);
    fail("pohunek failed to start");
  }
});

child.stdout.on("data", (chunk) => {
  chunks.push(chunk);
});

child.on("close", (code, signal) => {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timer);
  if (code !== 0) {
    fail(
      signal !== null && signal !== undefined
        ? `pohunek ${signal}`
        : `pohunek exited ${String(code)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("inspect output is not JSON");
  }
  const token = parsed?.ok?.metadata?.["moc.meterToken"];
  if (typeof token !== "string") {
    fail("no meter token in session metadata");
  }
  if (!TOKEN_PATTERN.test(token)) {
    fail("meter token is malformed");
  }
  process.stdout.write(token);
});
