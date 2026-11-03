# Merged PRs on 2026-11-02 and 2026-11-03 (UTC) — git-history analysis

In UTC, 17 PRs were merged into `main` at `0cc0cef2d501723fc345f55d79ac8af2c585c67c` (`git merge-base origin/main HEAD` → `0cc0cef2d501723fc345f55d79ac8af2c585c67c`) between 2026-11-02 and 2026-11-03 (`git log --merges --first-parent --since="2026-11-02 00:00:00 UTC" --until="2026-11-03 23:59:59 UTC" --format=%H | wc -l` → 17). Factory branches (`moc/` from `config/dispatcher.json` `branchPrefix`) contributed 4 of 17 (`git log --merges --first-parent --since="2026-11-02 00:00:00 UTC" --until="2026-11-03 23:59:59 UTC" --format=%s | grep -c "from pohunekd/moc/"` → 4) and 13 did not (`echo $((17-4))` → 13); per day, 2026-11-02 had 15 PRs with 4 factory and 11 other, 2026-11-03 had 2 PRs with 0 factory and 2 other.

## Merged PRs

Columns use the merge commit `M` (full SHA in section “How each number was computed”): merged time `git log -1 --format=%ct M | xargs -I{} date -u -d @{} '+%Y-%m-%d %H:%M:%S UTC'`, commits `git rev-list --count M^1..M^2`, files `git diff --numstat M^1 M | wc -l`, added `git diff --numstat M^1 M | awk '{a+=$1} END {print a+0}'`, removed `git diff --numstat M^1 M | awk '{r+=$2} END {print r+0}'`, changed `git diff --numstat M^1 M | awk '{s+=$1+$2} END {print s+0}'` (checked with `git diff --shortstat M^1 M`).

| PR   | Branch                          | Title (second line of `git show -s --format=%B M`)                                                     | Merged (UTC)            | Commits | Files | Added | Removed | Changed |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------- | ------- | ----- | ----- | ------- | ------- |
| #308 | pohunekd/306-real-work-cards    | live: Real work now cards and Just finished strip                                                      | 2026-11-03 06:05:13 UTC | 11      | 6     | 1691  | 260     | 1951    |
| #309 | pohunekd/306b1-fleet-100        | Simulate 100-machine evening fleet                                                                     | 2026-11-03 04:12:49 UTC | 1       | 4     | 43    | 43      | 86      |
| #305 | pohunekd/302-detail-panels      | feat(dashboard): detail panels for task, call and audit (PR2 of #301)                                  | 2026-11-02 21:17:37 UTC | 7       | 9     | 1737  | 145     | 1882    |
| #304 | pohunekd/301-unified-dashboard  | feat(dashboard): unify / with view tabs and replay (PR1 of #301)                                       | 2026-11-02 16:31:07 UTC | 8       | 6     | 1071  | 438     | 1509    |
| #300 | pohunekd/moc/gh-moc-299         | Tests: drop dead maps in the sim row, assert host lines without task fail /live                        | 2026-11-02 11:29:27 UTC | 1       | 2     | 36    | 35      | 71      |
| #298 | pohunekd/297-task-cycle         | Sim: cycle task labels per block and fix #296 lows                                                     | 2026-11-02 11:13:09 UTC | 1       | 7     | 443   | 66      | 509     |
| #296 | pohunekd/295-sim-task-labels    | Sim: task-labeled work blocks and live display                                                         | 2026-11-02 10:44:06 UTC | 1       | 8     | 421   | 19      | 440     |
| #287 | pohunekd/285-live-view          | Live dashboard view at /live: fleet grid, real Meta model activity, event ticker                       | 2026-11-02 10:18:58 UTC | 4       | 7     | 1784  | 16      | 1800    |
| #294 | pohunekd/moc/gh-moc-293         | Report: make building-itself.md readable in one minute (numbers up front, commands in a final section) | 2026-11-02 10:18:12 UTC | 1       | 1     | 52    | 20      | 72      |
| #292 | pohunekd/moc/gh-moc-289         | Report: how this factory built itself (git-history analysis in docs/reports/)                          | 2026-11-02 10:02:44 UTC | 1       | 1     | 28    | 0       | 28      |
| #291 | pohunekd/moc/gh-moc-290         | Docs: Beyond code - which layers are task-agnostic and which are code-shaped                           | 2026-11-02 10:01:15 UTC | 1       | 2     | 44    | 0       | 44      |
| #286 | pohunekd/284-fleet-simulator    | Simulator: fleet what-if with deterministic timeline (#284)                                            | 2026-11-02 09:50:46 UTC | 4       | 7     | 2049  | 0       | 2049    |
| #283 | pohunekd/264-rust-package       | host-state Rust port 7/7: build and digest the Rust package as moc.host-state 0.6.0                    | 2026-11-02 05:17:36 UTC | 4       | 6     | 611   | 87      | 698     |
| #282 | pohunekd/263-rust-binary        | host-state Rust port 6/7: moc-host-state binary and live TS/Rust comparison in CI                      | 2026-11-02 04:14:35 UTC | 3       | 9     | 627   | 6       | 633     |
| #281 | pohunekd/262-rust-probe-output  | host-state: run_probe, HostCapacity writer and shared scenario suite                                   | 2026-11-02 03:25:11 UTC | 2       | 5     | 1194  | 0       | 1194    |
| #280 | pohunekd/261-rust-macos-readers | host-state Rust port 4/7: macOS readers and local models query                                         | 2026-11-02 02:10:09 UTC | 4       | 7     | 575   | 1       | 576     |
| #279 | pohunekd/260-rust-linux-readers | host-state Rust port 3/7: Linux readers (power, GPU, memory, CPU, logind)                              | 2026-11-02 01:11:16 UTC | 3       | 18    | 749   | 7       | 756     |

## Factory share per day

- 2026-11-02: 15 total (`git log --merges --first-parent --since="2026-11-02 00:00:00 UTC" --until="2026-11-02 23:59:59 UTC" --format=%H | wc -l` → 15), 4 factory (`git log --merges --first-parent --since="2026-11-02 00:00:00 UTC" --until="2026-11-02 23:59:59 UTC" --format=%s | grep -c "from pohunekd/moc/"` → 4), 11 other (`echo $((15-4))` → 11).
- 2026-11-03: 2 total (`git log --merges --first-parent --since="2026-11-03 00:00:00 UTC" --until="2026-11-03 23:59:59 UTC" --format=%H | wc -l` → 2), 0 factory (`git log --merges --first-parent --since="2026-11-03 00:00:00 UTC" --until="2026-11-03 23:59:59 UTC" --format=%s | grep "from pohunekd/moc/" | wc -l` → 0), 2 other (`echo $((2-0))` → 2).

Factory is branch prefix `moc/` (`grep branchPrefix config/dispatcher.json` → `"branchPrefix": "moc/"`).

## Top-level directories by changed lines (2026-11-02 to 2026-11-03)

Net change between the last merge before the period (`3dc704994583fee016167ececc62c1d6155ad62d`, `git rev-parse 2732f2c^1` → `3dc704994583fee016167ececc62c1d6155ad62d`) and the last merge of the period (`0cc0cef2d501723fc345f55d79ac8af2c585c67c`, `git merge-base origin/main HEAD` → `0cc0cef2d501723fc345f55d79ac8af2c585c67c`) is 12266 changed lines (`git diff --numstat 3dc704994583fee016167ececc62c1d6155ad62d 0cc0cef2d501723fc345f55d79ac8af2c585c67c | awk '{s+=$1+$2} END {print s}'` → 12266).

- `src/`: 5672 (`git diff --numstat 3dc704994583fee016167ececc62c1d6155ad62d 0cc0cef2d501723fc345f55d79ac8af2c585c67c | awk -F"\t" '$3 ~ /^src\// {s+=$1+$2} END {print s+0}'` → 5672)
- `crates/`: 2908 (`git diff --numstat 3dc704994583fee016167ececc62c1d6155ad62d 0cc0cef2d501723fc345f55d79ac8af2c585c67c | awk -F"\t" '$3 ~ /^crates\// {s+=$1+$2} END {print s+0}'` → 2908)
- `tests/`: 2139 (`git diff --numstat 3dc704994583fee016167ececc62c1d6155ad62d 0cc0cef2d501723fc345f55d79ac8af2c585c67c | awk -F"\t" '$3 ~ /^tests\// {s+=$1+$2} END {print s+0}'` → 2139)
- `scripts/`: 657 (`git diff --numstat 3dc704994583fee016167ececc62c1d6155ad62d 0cc0cef2d501723fc345f55d79ac8af2c585c67c | awk -F"\t" '$3 ~ /^scripts\// {s+=$1+$2} END {print s+0}'` → 657)
- `docs/`: 380 (`git diff --numstat 3dc704994583fee016167ececc62c1d6155ad62d 0cc0cef2d501723fc345f55d79ac8af2c585c67c | awk -F"\t" '$3 ~ /^docs\// {s+=$1+$2} END {print s+0}'` → 380)
- `config/`: 313 (`git diff --numstat 3dc704994583fee016167ececc62c1d6155ad62d 0cc0cef2d501723fc345f55d79ac8af2c585c67c | awk -F"\t" '$3 ~ /^config\// {s+=$1+$2} END {print s+0}'` → 313)
- `.github/`: 100 (`git diff --numstat 3dc704994583fee016167ececc62c1d6155ad62d 0cc0cef2d501723fc345f55d79ac8af2c585c67c | awk -F"\t" '$3 ~ /^\.github\// {s+=$1+$2} END {print s+0}'` → 100)

Ranked via `git diff --numstat 3dc704994583fee016167ececc62c1d6155ad62d 0cc0cef2d501723fc345f55d79ac8af2c585c67c | awk -F"\t" '{n=split($3,a,"/"); top=a[1]; if(n==1) top="(root)"; s[top]+=$1+$2} END {for (d in s) print d, s[d]}' | sort -k2 -nr`.

## How each number was computed

All counts at `origin/main` `0cc0cef2d501723fc345f55d79ac8af2c585c67c` (`git rev-parse origin/main` → `0cc0cef2d501723fc345f55d79ac8af2c585c67c`). Merge base `git merge-base origin/main HEAD` → `0cc0cef2d501723fc345f55d79ac8af2c585c67c`; local `main` `4df2afbfc6fb5e602d8cbd4f0d07be89a929a222` is behind (`git rev-parse main`). Period bounds from `git log --merges --first-parent --date=iso --format='%H %ad %s' HEAD` filtered to UTC dates 2026-11-02 and 2026-11-03 (UTC conversion `git log -1 --format=%ct M | xargs -I{} date -u -d @{} '+%Y-%m-%d %H:%M:%S UTC'`).

- PR list (17): `git log --merges --first-parent --since="2026-11-02 00:00:00 UTC" --until="2026-11-03 23:59:59 UTC" --format='%H %s' HEAD`
- Per-PR SHAs: `0cc0cef2d501723fc345f55d79ac8af2c585c67c` (#308), `45f91a516a95ca6961739c1c04d63dde483c2540` (#309), `bfe76c0a9dbe3d73ef786cc3020b2aca1417b399` (#305), `7a9df3445b00c25eaa7a742bc7066b9a08b189a3` (#304), `8033b02da336dd47ee02c3089c096bfd0ad7ade8` (#300), `928625d926d934ecfc338ea89381710d3837e725` (#298), `dca3c82bb81aecdfed5a2731c15a17bedc33e63f` (#296), `d9d2a31960de1d1bb37ce8dc087ca2c80485eb5a` (#287), `a724654334bd3b20955e6fd11744602eae8e3e8a` (#294), `2cbd2958212e000c6793d799635cae89f5999229` (#292), `5ce1255ad8f57eeba346320b3f64a59662e20179` (#291), `949151de0bb626dbe196e481bb762e6f0015eadf` (#286), `f7fb5bc949067f13b0d45fd1bfdc4808cfa764b8` (#283), `515270fbfc6b242cb8e64cb453055d6b18e68866` (#282), `92ea6848e261d7fde537d9e2216b089d2b4dd22c` (#281), `f1c7de9af0146f596b7b7d48ba5f51812bbe1b28` (#280), `2732f2c61f3db4f2b981f0de7cf659a26bc46a0d` (#279). Each `git show -s --format=%B M` gives PR number from first line and title from third line.
- Commits per PR (11, 1, 7, 8, 1, 1, 1, 4, 1, 1, 1, 4, 4, 3, 2, 4, 3): `git rev-list --count M^1..M^2` for each SHA above.
- Files per PR (6, 4, 9, 6, 2, 7, 8, 7, 1, 1, 2, 7, 6, 9, 5, 7, 18): `git diff --numstat M^1 M | wc -l` (matches `git diff --shortstat M^1 M` files).
- Lines added/removed/changed per PR: `git diff --numstat M^1 M | awk '{a+=$1; r+=$2} END {print a, r, a+r}'` for each SHA (values in table). Verified with `git diff --shortstat M^1 M`.
- Directory totals in section above: net diff commands listed there; top-level identified by first path component via `awk -F"\t"`.

No host name, local path, session id or secret appears in history or report (`grep -r "moc-"` only shows branch names).
