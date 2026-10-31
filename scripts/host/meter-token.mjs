// Host helper: print the meter token the daemon put into this session's
// secret env slot. pi runs it as the provider apiKey command and sends the
// printed value as Authorization: Bearer. The slot name is the only argument.
import process from "node:process";

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const TOKEN_PATTERN = /^moc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

function fail(step) {
  process.stderr.write(`meter-token: ${step}\n`);
  process.exit(1);
}

const name = process.argv[2] ?? "";
if (name === "") {
  fail("no slot name argument");
}
if (process.argv.length > 3 || !NAME_PATTERN.test(name)) {
  fail("slot name is invalid");
}
const token = process.env[name] ?? "";
if (token === "") {
  fail(`${name} is not set`);
}
if (!TOKEN_PATTERN.test(token)) {
  fail("meter token is malformed");
}
process.stdout.write(token);
