# Coding guide

## TypeScript

- Bun runtime and package manager; `strict` TypeScript with
  `noUncheckedIndexedAccess`. ESLint (`strictTypeChecked`) and Prettier are gates.
- Explicit return types on exported functions. No `any`; narrow `unknown` instead.
- `async`/`await` over raw promise chains.
- Handle specific errors. A caught error is either handled with intent or rethrown
  with context; never swallowed.
- Names: `camelCase` for functions and variables, `PascalCase` for types and
  classes.
- Comments explain a non-obvious reason or constraint and describe the current
  code. One or two lines.

## Configuration

- Tunable values (timeouts, limits, URLs, prices, caps, aliases) live in `config/`
  and are read through one typed config module. No literals in component code.
- Secrets come only from environment variables named in config. Read them at
  startup through a helper that fails with a clear error when a required variable
  is missing. No invented defaults for required values.

## Security

- Never log, print, or pass a secret in argv. Prompts and secret-bearing payloads
  go to child processes through stdin or files with mode 600.
- Validate every input that crosses a boundary (MCP calls, probe reports, model
  output) against its contract schema before use.
- Model output is untrusted data. It never becomes a shell command, a merge, or a
  config change without a check outside the model.

## Logging

Every server process writes structured JSON logs to `logs/` (gitignored): requests,
responses, MCP tool calls, placement decisions, dispatcher events, errors, and
timings. Logs carry host aliases, never secrets or overlay addresses.
