# Host state plugin

The host probe (`src/probe/`) ships to fleet hosts as a compiled plugin package.
A Pohunek release with a host-state extension point (PR 3) will run the plugin
on each host and carry its `HostCapacity` output back to the coordinator, where
a planned collector (PR 2) validates it before placement sees it.

## Package contents

`plugin:build` assembles one directory per target:

```text
moc-host-state-<version>-<target>/
  bin/moc-host-state          compiled plugin entry (src/probe/plugin-entry.ts)
  config/probe.json           fleet-wide probe policy
  config/scenarios/*.json     scenario inputs (tests and diagnosis only)
  build.json                  { packageId, version, target, gitCommit, sourceDigest, bunVersion, binarySha256 }
```

`config/hosts.json` is never copied into the package: a digest-pinned package
is identical on every host and cannot carry a per-host fact, and a fleet-wide
hostname map would put private hostnames into a distributed artifact.

## Building and checking the digest

```sh
bun run plugin:digest
bun run plugin:build --target native --out <dir>   # builds for this machine
bun run plugin:build --target all --out <dir>      # one directory per target in config/host-state.json
```

Both `--target` and `--out` are required. `--out` must be absent or an empty
directory; the script never overwrites. The native build carries no `--target`
flag and records `native-<platform>-<arch>` in `build.json`.
`plugin:build` refuses to build when `plugin:digest` does not match, so a stale
digest cannot be built.

The source digest pins the source inputs of the binary: every repo file
the bundle includes (from the `Bun.build` metafile, excluding `node_modules/`),
plus `bun.lock`, `config/probe.json` and every `config/scenarios/*.json` file.
The toolchain is recorded separately as `bunVersion` in `build.json`.
`plugin:digest` prints the digest and exits 0 only when it equals
`package.sourceDigest` in `config/host-state.json`.

## Version rule

Any change that alters the digest must also bump `package.version` and add the
new version to `collector.acceptedVersions` (owned by the collector change).
Old versions stay in `acceptedVersions` only while hosts are being upgraded.
Removing one makes those hosts `unavailable` with cause
`version-not-accepted`, which is the intended way to retire a build whose idle
rule is outdated.

## Host precondition

Every fleet host carries its alias in `~/.config/means-of-compute/host.json`:

```json
{ "hostAlias": "laptop-a" }
```

The plugin reads this file for a live run (never the hostname, never
`config/hosts.json`). A missing file or an invalid alias fails the plugin run,
which the collector reports as `plugin-failed`.

## Artifacts

Built packages are never committed (`dist/` is gitignored) and never published
from this repository. The owner builds `--target all` once per version and
installs that one archive per target on every host, by its sha256. A rebuild
is a new artifact with a new digest.
