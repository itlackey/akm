# Session Pickup — 2026-06-14 (akm improve redesign + 0.9.0-beta.9)

> Read this first to continue where the 2026-06-14 session left off.
> Related memories: `akm-improve-delta-only-throughput-collapse`,
> `akm-improve-success-metric`, `akm-release-gate-run-full-check` (project +
> akm stash). Design: `docs/design/improve-proactive-maintenance.md`.

## TL;DR

Diagnosed why `akm improve` stopped producing reflect/distill output, fixed the
root causes, added a proactive lane + attribution + a measurement/kill-criterion
system, and right-sized timeouts. **All code is merged to `main`, built, and
deployed (cron runs `dist/cli.js`).** The **0.9.0-beta.9 npm publish is BLOCKED**
by an index-db test regression that fails `bun run check` in CI. Production is
NOT broken — it's a test-harness issue.

## The investigation (so it isn't redone)

- Root cause of "no improve output": the signal-delta eligibility gate was the
  ONLY lane → cache "no-access = no-work" pathology in steady state. The
  high-retrieval fallback (P0-A) was structurally dead (zero-feedback assets hit
  the fully-skipped branch one phase before the fallback). `getRetrievalCounts`
  dropped ~half the signal (bare vs `origin//` ref mismatch) and ignored curate.
  Per-ref `no_new_signal` events flooded state.db (~400K/day) → 900s timeouts.
- The signal-delta gate is **load-bearing** (fixed the 2026-05-26 synchronized-
  wave incident, commit `6a5e0ca4`); a budget-cap design was tried and removed
  (`4c1700b2`). Do NOT remove the gate or reintroduce cooldowns.
- Principle: separate "decide to LOOK" (liberal selection) from "decide to
  CHANGE" (gated, default no-op). akm already has the CHANGE gate (#580
  empty-diff/cosmetic suppression `reflect.ts`; additive distill `distill.ts`),
  so a liberal proactive selector is SAFE.
- Success metric = coverage + accepted-change-rate vs a do-nothing baseline.
  NOT promotion volume (the June "high output" was a journal.jsonl sessionId bug
  + a backfill = noise). See `memory:akm-improve-success-metric`.

## Shipped to `main` (synced with origin)

| commit | what |
|---|---|
| `e8fb4bf1` | Layer 1: revive P0-A, normalize getRetrievalCounts refs + count curate, aggregate `no_new_signal` event |
| `63e626ca` | Layer 2: proactive-maintenance selector (`src/commands/improve/proactive-maintenance.ts`), disabled by default |
| `f068b761` | attribute proposals by `eligibilitySource` {signal-delta, high-retrieval, proactive, scope, unknown} |
| `3e12234b` | akm-eval real-query suite + `akm-eval-proactive-verdict` kill-criterion |
| `c6fe2c0e` | design doc + issue |
| `bd0a63e5` | bump to 0.9.0-beta.9 + CHANGELOG |
| `8172cb0e` | **revert** of the stray `feature-gate.ts` change (broke its tests) |
| `5e3d8e39` | test-isolation fix (use `withIsolatedAkmStorage`) |

## Live / deployed (operational)

- Cron uses `~/.local/bin/akm` wrapper → `dist/cli.js` (rebuilt this session).
- **Config** `~/.config/akm/config.json` (backed up `*.bak-*`):
  - new `proactive-maintenance` improve profile (proactiveMaintenance enabled,
    dueDays 30, maxPerRun 100; reflect/distill/triage on; consolidate/extract off)
  - right-sized reflect limits: `quick` 25→8, `reflect-distill` 25→18
- **Scheduled tasks** (`~/akm/tasks/`, in cron):
  - `akm-improve-proactive-weekly` — Sun 05:00, 3h timeout (ENABLED)
  - `akm-improve-proactive-verdict-monthly` — 1st 06:00, posts verdict to Discord
    (same webhook as health report, via `akm env run fwdslsh`)
- **state.db** cleaned: 4.78M `no_new_signal` rows deleted + VACUUM (2.77→1.52GB).
  Backup: `~/.local/share/akm/state.db.bak-20260614T111545` (delete when happy).
- Stale proposal `23a7b775` rejected.
- Baseline tag (stash `~/akm`): `baseline/pre-proactive-2026-06-14`.
- Pilot treatment set: `~/akm/.akm/measurement/treatment-pilot-2026-06-14.txt`.

## ⛔ OPEN BLOCKER #1 — 0.9.0-beta.9 NOT published

`release.yml` (manual `gh workflow run release.yml --ref main -f version=0.9.0-beta.9`)
failed twice at `bun run check`:
1. lint (FIXED — `withIsolatedAkmStorage`)
2. `test:unit`: index-db tests fail in CI — `no such table: entries` /
   `no such table: usage_events` (curate, searchInWiki, akmSearch, Auto-index,
   memory-search). **Same bun 1.3.14 as beta.8's passing run → regression is in
   today's commits.**

Debug plan (see `akm-release-gate-run-full-check` memory):
- `src/indexer/db/db.ts` is RULED OUT (pure-additive: bareRef + SELECT).
- Suspects: (a) `src/commands/read/curate.ts` per-item `insertUsageEvent` loop;
  (b) a NEW test file (e.g. `tests/get-retrieval-counts.test.ts`) polluting CI's
  sequential `TEST_PARALLEL=1` shared index-db/global state.
- Reproduce CI-faithfully (the LOCAL env has its own index-db sensitivity that
  masks it — curate fails standalone locally even at beta.8 baseline). Use a
  clean checkout + `TEST_PARALLEL=1 bun run test:unit`; bisect by temporarily
  removing today's new test files; check whether `logCurateEvent` opens/creates
  a bare index db.
- When `TEST_PARALLEL=1 bun run check` is green: re-dispatch release for
  `0.9.0-beta.9` (version already bumped; nothing published; version is reusable).

## Other open items / decisions

- **Always run `TEST_PARALLEL=1 bun run check` before merge/release** — the core
  process lesson; we kept skipping it (tsc+biome+partial test ≠ the gate).
- The reverted `feature-gate.ts` change (session_extraction always-on) is a real
  improvement — reintroduce SEPARATELY with updated `extract-profile-gate.test.ts`
  + `extract-command.test.ts` (they assert the old default-profile-gates-all
  behavior).
- Layer-2 proactive lane verdict is currently **INCONCLUSIVE** (only ~15 decided
  proactive proposals; needs ≥30). After a few weekly cycles run
  `scripts/akm-eval/bin/akm-eval-proactive-verdict --stash ~/akm`; FAIL →
  disable `akm-improve-proactive-weekly`.
- Backups to delete once satisfied: `~/.local/share/akm/state.db.bak-*`,
  `~/.config/akm/config.json.bak-*`.

## Verify-state commands

```sh
cd ~/code/github/itlackey/akm
git log --oneline bbe12b6d..HEAD          # today's work
AKM_MODE=build akm --version              # 0.9.0-beta.9 (local build)
npm view akm-cli@0.9.0-beta.9 version     # E404 until the blocker is fixed
gh run list --workflow=release.yml --limit 3
AKM_MODE=build akm tasks list | grep -i proactive
TEST_PARALLEL=1 bun run check             # the gate that must pass before release
```
