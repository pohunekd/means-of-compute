# How this factory built itself — git-history analysis

44 of 166 merged PRs (27%) came from factory branches with prefix `moc/`, and 122 did not.
The per-day UTC split and the three largest factory PRs by changed lines are listed below.

This report was written by the factory as a non-code task (issue #289); this restructure is issue #293.

## Merged PRs per UTC day

| Date       | Factory | Other | Total |
| ---------- | ------- | ----- | ----- |
| 2026-10-26 | 0       | 4     | 4     |
| 2026-10-27 | 0       | 15    | 15    |
| 2026-10-28 | 0       | 36    | 36    |
| 2026-10-29 | 0       | 22    | 22    |
| 2026-10-30 | 9       | 9     | 18    |
| 2026-10-31 | 13      | 9     | 22    |
| 2026-11-01 | 20      | 21    | 41    |
| 2026-11-02 | 2       | 6     | 8     |

## Three largest factory PRs by changed lines

- #173: 803
- #177: 261
- #157: 231

## How each number was computed

All counts use `origin/main` at the merge base
`git merge-base origin/main HEAD` → `2cbd2958212e000c6793d799635cae89f5999229`.

- Total merged PRs (166):
  `git log --merges --format=%s origin/main | grep -c "^Merge pull request"`
- Factory PRs (44):
  `git log --merges --format=%s origin/main | grep -c "from pohunekd/moc/"`
- Other PRs (122):
  `git log --merges --format=%s origin/main | grep "Merge pull request" | grep -vc "from pohunekd/moc/"`
- Factory share (27%):
  `awk 'BEGIN {printf "%.0f\n", 44/166*100}'`
- Branch prefix (`moc/`) from `config/dispatcher.json` `branchPrefix`.
- Dates in table from:
  `git log --merges --format="%ct %s" origin/main | grep "Merge pull request" | cut -d" " -f1 | xargs -I{} date -u -d @{} +%F | sort -u`
- Factory per day (<date> → number):
  `git rev-list --count --merges --grep="from pohunekd/moc/" origin/main --since="<date> 00:00:00 UTC" --until="<date> 23:59:59 UTC"`
  Run for: 2026-10-26, 2026-10-27, 2026-10-28, 2026-10-29, 2026-10-30, 2026-10-31, 2026-11-01, 2026-11-02.
- Total per day (<date> → number):
  `git rev-list --count --merges --grep="Merge pull request" origin/main --since="<date> 00:00:00 UTC" --until="<date> 23:59:59 UTC"`
  Run for: 2026-10-26, 2026-10-27, 2026-10-28, 2026-10-29, 2026-10-30, 2026-10-31, 2026-11-01, 2026-11-02.
- Other per day (<date> → number):
  `echo $(( $(git rev-list --count --merges --grep="Merge pull request" origin/main --since="<date> 00:00:00 UTC" --until="<date> 23:59:59 UTC") - $(git rev-list --count --merges --grep="from pohunekd/moc/" origin/main --since="<date> 00:00:00 UTC" --until="<date> 23:59:59 UTC") ))`
  Run for: 2026-10-26, 2026-10-27, 2026-10-28, 2026-10-29, 2026-10-30, 2026-10-31, 2026-11-01, 2026-11-02.
- #173 changed lines (803):
  `git diff --numstat bba736200497a11de9478a571b06dd09a95a72be^1 bba736200497a11de9478a571b06dd09a95a72be | awk '{s+=$1+$2} END {print s}'`
  Checked with `git diff --shortstat bba736200497a11de9478a571b06dd09a95a72be^1 bba736200497a11de9478a571b06dd09a95a72be`
- #177 changed lines (261):
  `git diff --numstat 8fe81ae0232c6283a6d5c3139024e10e5913e369^1 8fe81ae0232c6283a6d5c3139024e10e5913e369 | awk '{s+=$1+$2} END {print s}'`
  Checked with `git diff --shortstat 8fe81ae0232c6283a6d5c3139024e10e5913e369^1 8fe81ae0232c6283a6d5c3139024e10e5913e369`
- #157 changed lines (231):
  `git diff --numstat 2f962cf9f307d2031053417a7dafda1ee7ad1159^1 2f962cf9f307d2031053417a7dafda1ee7ad1159 | awk '{s+=$1+$2} END {print s}'`
  Checked with `git diff --shortstat 2f962cf9f307d2031053417a7dafda1ee7ad1159^1 2f962cf9f307d2031053417a7dafda1ee7ad1159`
