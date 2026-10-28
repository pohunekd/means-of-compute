# Host state plugin

The host probe (`src/probe/`) ships to fleet hosts as a bundled plugin package.
A Pohunek release with a host-state extension point (PR 3) will run the plugin
on each host and carry its `HostCapacity` output back to the coordinator, where
the collector validates it before placement sees it.

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
  config/probe.json           fleet-wide probe policy
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
digest-pinned inputs. Writing it needs `sudo` once on every host. The plugin
reads this file for a live run (never the hostname, never
`config/hosts.json`). A missing file or an invalid alias fails the plugin run,
which the collector reports as `plugin-failed`.

## Artifacts

Built packages are never committed (`dist/` is gitignored) and never published
from this repository. The owner builds once per version and installs that one
directory on every host with `pohunek plugin link`, by its sha256. A rebuild
is a new artifact with a new digest.

## Causes

Every failure maps to one `unavailable` observation with a cause; placement
records it as an excluded candidate. No failure yields a `reported` host.

| Input or condition                                                                        | Cause                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `config/host-state.json` missing, unreadable, invalid, extra key, or a failed cross-check | throw naming the key; no default                  |
| `config/probe.json` missing in the package                                                | `plugin-failed`                                   |
| host file missing or invalid                                                              | `plugin-failed`                                   |
| unknown plugin argument                                                                   | `plugin-failed`                                   |
| host or daemon unreachable, overlay down                                                  | `host-unreachable`                                |
| daemon older than the extension point                                                     | `daemon-unsupported`                              |
| protocol version mismatch or translation failure                                          | `daemon-rejected` with code                       |
| package not installed, or no host-state program                                           | `plugin-missing`                                  |
| package disabled                                                                          | `plugin-disabled`                                 |
| concurrency limit                                                                         | `plugin-busy`                                     |
| plugin exit non-zero or signal                                                            | `plugin-failed`                                   |
| plugin past `pluginTimeoutMs`                                                             | `plugin-timeout`                                  |
| SDK deadline passed                                                                       | `request-timeout`                                 |
| adapter never settles                                                                     | `request-timeout` from the guard                  |
| stdout over the cap (daemon or collector)                                                 | `output-too-large`                                |
| stdout not UTF-8                                                                          | `output-invalid`                                  |
| other package id in the reply                                                             | `package-mismatch`                                |
| version not accepted                                                                      | `version-not-accepted`                            |
| not JSON, or more than one document                                                       | `not-json`                                        |
| not a `HostCapacity`, `freeMb > totalMb`, or an unparseable timestamp                     | `contract-invalid`                                |
| reported alias differs from the asked alias                                               | `alias-mismatch`                                  |
| timestamp too old                                                                         | `stale`                                           |
| timestamp too far ahead                                                                   | `future-timestamp`                                |
| non-port error from the adapter                                                           | `collect()` rejects; nothing is placed this round |

## Deadlines

With `c = config.collector`:

- `pluginTimeoutMs` (`10000`): the daemon kills the plugin at this deadline.
- `requestTimeoutMs` (`pluginTimeoutMs + transportMarginMs`): passed to the
  daemon as the call deadline; the adapter sets no timer of its own.
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
