# Host state plugin

The host probe (`src/probe/`) ships to fleet hosts as a bundled plugin package.
A Pohunek daemon from 0.38.1 on runs the plugin as a package command
(`package-commands-v1`) on each host and carries its `HostCapacity` output back
to the coordinator, where the collector validates it before placement sees it.

## Collector

`src/hoststate/collector.ts` asks every host in `port.hosts()` for the plugin
output in parallel through `HostStatePort` and turns each reply into one
`HostObservation`: `reported` with the validated `HostCapacity`, or
`unavailable` with a cause. A failure never yields an idle host.

## Package contents

`plugin:build` assembles one directory:

```text
moc-host-state-<version>/
  runtime.toml                package manifest consumed by the host daemon
  bin/moc-host-state          bundled plugin entry (src/probe/plugin-entry.ts)
  config/plugin.json          fleet-wide host file path
  config/probe.json           fleet-wide probe policy and macOS tool paths
  config/scenarios/*.json     scenario inputs (tests and diagnosis only)
  build.json                  { packageId, version, command, gitCommit, sourceDigest, bunVersion, binarySha256 }
```

`config/hosts.json` is never copied into the package: a digest-pinned package
is identical on every host and cannot carry a per-host fact, and a fleet-wide
hostname map would put private hostnames into a distributed artifact.

## Building and checking the digest

```sh
bun run plugin:digest
bun run plugin:build --out <dir>
```

`--out` is the only argument. `--out` must be absent or an empty
directory; the script never overwrites.
`plugin:build` refuses to build when `plugin:digest` does not match, so a stale
digest cannot be built.

The source digest pins the source inputs of the bundle: every repo file
the bundle includes (from the `Bun.build` metafile, excluding `node_modules/`),
plus `bun.lock`, `config/plugin.json`, `config/probe.json` and every `config/scenarios/*.json` file.
The toolchain is recorded separately as `bunVersion` in `build.json`.
`plugin:digest` prints the digest and exits 0 only when it equals
`package.sourceDigest` in `config/host-state.json`.

## Version rule

Any change that alters the digest must also bump `package.version` and add the
new version to `collector.acceptedVersions`. Old versions stay in
`acceptedVersions` only while hosts are being upgraded. Removing one makes
those hosts `unavailable` with cause `version-not-accepted`, which is the
intended way to retire a build whose idle rule is outdated.

## Host precondition

Every fleet host carries its alias in `/etc/means-of-compute/host.json`:

```json
{ "hostAlias": "laptop-a" }
```

The fleet-wide path lives in the package as `config/plugin.json`; the host file
itself stays outside the package, outside `HOME`, and outside the
digest-pinned inputs. Writing it needs `sudo` once on every host.

The host file may carry an optional `unattended` window `{ "start": "HH:MM", "end": "HH:MM" }`
in host local time, where equal values mean the whole day. Writing it needs `sudo`, like the alias. It is Linux only:
inside a host's unattended window a local login without an active graphical
session is judged by its logind idle hint instead of reporting activity
unknown. A bad value fails the plugin run (`plugin-failed`).

The launch `PATH` the daemon gives the plugin must provide `bun`, because the
bundle starts with `#!/usr/bin/env bun`.

The plugin
reads this file for a live run (never the hostname, never
`config/hosts.json`). A missing file or an invalid alias fails the plugin run,
which the collector reports as `plugin-failed`.

## Idle detection and agent runtime

- On Linux the probe reads the logind `IdleHint` and `IdleSinceHint` of the active local graphical session. A compositor that never sets the hint (such as sway) makes the host report recent input forever, so it is never idle. Run an idle daemon that sets the hint, for example swayidle with `idlehint 60`. `secondsSinceInput` then counts from the moment the hint was set, so the host turns idle `idleMinutes` (`config/probe.json`) plus the `idlehint` timeout after the last input: 16 minutes with `idleMinutes: 15` and `idlehint 60`.
- A local login without an active graphical session, such as a TTY-only login, reports activity unknown and is never idle. Inside a host's `unattended` window, such a login is judged by its logind idle hint instead, and the reason names the window. Remote (SSH) sessions are ignored: a host with only SSH sessions counts as logged out and can be reported idle.
- The Pohunek daemon resolves agent programs (`pi`, and `node` for the `pi` shebang) on its own process `PATH`, like the `bun` the plugin needs (see "Host precondition"). That `PATH` is fixed when the Pohunek service is installed (the launchd job on macOS, the systemd user manager environment on Linux). Place the agent where that `PATH` already looks, or reinstall the service after installing the agent: editing `search_path` in the service config takes effect only at a version-changing service upgrade or a reinstall.
- The daemon's version probe runs the agent with a minimal environment, so an agent wrapper script must use absolute paths instead of `$HOME`.
- Check a host with `pohunek host inspect <host> --json`: the agent's runtime entry must show `available: true`, `supported: true` and a version.

## Adapter

`src/dispatcher/adapter/host-state-port.ts` reads plugin output through the
daemon's `command.run`: one call per host with `package` set to the
configured package id, `command` set to `host-state`, `timeout_ms` set to
`limits.pluginTimeoutMs`, and `max_output_bytes` set to
`limits.maxOutputBytes`. `requestTimeoutMs` is never sent to the daemon.
SDK errors map to `HostStateError` through
`src/dispatcher/adapter/host-state-map.ts`; anything unmapped is rethrown
and the whole `collect()` rejects. A `host-unreachable` or `request-timeout`
error drops the connection as best effort before the mapped error is thrown,
so the next round re-resolves the route. `hosts()` returns the connector
aliases in sorted order. The first `close()` marks the port closed and
closes the connector; later `close()` calls return at once, and a later
`read()` throws `host state port is closed`.

## Artifacts

Built packages are never committed (`dist/` is gitignored) and never published
from this repository. The owner builds once per version and installs that one
directory on every host with `pohunek plugin link`. Vouch first by digest: run
`pohunek plugin link <dir>` without `--yes` on the first host, record the
printed digest, and repeat the dry run on every other host to compare before
running `--yes`. Copy the directory with modes preserved: `bin/moc-host-state`
must keep `0755`, or the link fails. A rebuild
is a new artifact with a new digest.

## Causes

Every failure maps to one `unavailable` observation with a cause; placement
records it as an excluded candidate. No failure yields a `reported` host.

| Input or condition                                                                                                                         | Cause                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `config/host-state.json` missing, unreadable, invalid, extra key, or a failed cross-check                                                  | throw naming the key; no default                  |
| `config/probe.json` missing in the package                                                                                                 | `plugin-failed`                                   |
| host file missing or invalid                                                                                                               | `plugin-failed`                                   |
| unknown plugin argument                                                                                                                    | `plugin-failed`                                   |
| host or daemon unreachable, overlay down                                                                                                   | `host-unreachable`                                |
| daemon older than the extension point, without `command.run`                                                                               | `daemon-unsupported (command_unsupported)`        |
| protocol version mismatch or translation failure                                                                                           | `daemon-rejected` with code                       |
| package not installed, no version selected, or no such command                                                                             | `plugin-missing (<code>)`                         |
| package disabled                                                                                                                           | `plugin-disabled`                                 |
| concurrency limit                                                                                                                          | `plugin-busy`                                     |
| plugin exit or signal (`process_exit`)                                                                                                     | `plugin-failed (exit-<n>)` or (`signal-<n>`)      |
| plugin past `pluginTimeoutMs`                                                                                                              | `plugin-timeout`                                  |
| SDK deadline passed                                                                                                                        | `request-timeout`                                 |
| adapter never settles                                                                                                                      | `request-timeout` from the guard                  |
| stdout over the cap (daemon or collector)                                                                                                  | `output-too-large`                                |
| stdout not UTF-8                                                                                                                           | `output-invalid`                                  |
| other package id in the reply                                                                                                              | `package-mismatch`                                |
| the reply is missing a field                                                                                                               | `daemon-rejected (reply-incomplete)`              |
| the daemon cannot run the command (shutdown, unreadable registry, failed root verification, or a failed spawn such as a missing `#!` line) | `daemon-rejected (command_unavailable)`           |
| the command is declared `local` only                                                                                                       | `daemon-rejected (command_not_exposed)`           |
| version not accepted                                                                                                                       | `version-not-accepted`                            |
| not JSON, or more than one document                                                                                                        | `not-json`                                        |
| not a `HostCapacity`, `freeMb > totalMb`, or an unparseable timestamp                                                                      | `contract-invalid`                                |
| reported alias differs from the asked alias                                                                                                | `alias-mismatch`                                  |
| timestamp too old                                                                                                                          | `stale`                                           |
| timestamp too far ahead                                                                                                                    | `future-timestamp`                                |
| `PortRejectedError`, any other error                                                                                                       | `collect()` rejects; nothing is placed this round |

## Deadlines

With `c = config.collector`:

- `pluginTimeoutMs` (`10000`): the daemon kills the plugin at this deadline.
- `requestTimeoutMs` (`pluginTimeoutMs + transportMarginMs`): never sent to the
  daemon and never passed to the SDK. The SDK's own deadline ends a stuck run
  with `request-timeout`, the adapter sets no timer of its own, and the
  collector guard below ends a call that hangs past that.
- `guardMs` (`pluginTimeoutMs + 2 * transportMarginMs`): the collector's own
  bound through `deps.sleep`, for an adapter that never settles.
- `maxOutputBytes` (`16384`): passed to the daemon and re-checked by the
  collector on the verbatim stdout.
- `maxClockSkewMs` (`120000`): accepted clock difference between the plugin
  timestamp and the coordinator clock.

## Round rules

- `collect()` reads every alias in `port.hosts()` in parallel and returns one
  observation per alias, in `hosts()` order. A duplicate alias throws before
  any read.
- A failure of one host never delays or changes another host's observation.
- Coalescing: a `collect()` call while a round is in flight returns that
  round's promise. No port call is made twice for the same round.
- No cache: a finished round is never reused. Each placement uses a fresh
  round.
- Logs: one injected `HostStateLogEvent` per host per round. On a reply,
  `stdoutBytes` and `stdoutSha256` are set, and stdout itself is never logged.
  A `detail` never contains a route, an address, a hostname, or daemon message
  text.

## Observed placement

`src/placement/observed.ts` places over one collector round:

1. A duplicate `hostAlias` in the observations throws.
2. Reported capacities go through `place()` unchanged; scoring and `place()`
   do not change.
3. Every `unavailable` observation is appended to the candidates, in input
   order, as `{ hostAlias, score: 0, reason: "excluded: host state
unavailable (<cause>)", excluded: true }`.
4. When no host is chosen, the reason becomes `no eligible host: <N> of <N>
excluded`, where `N` counts all candidates. Otherwise the `place()` reason
   is kept.
5. The result is validated with `isPlacementDecision` and returned.
