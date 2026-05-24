# 0.8.0 Public Release Readiness — Execution Status

**Plan:** `.plans/0.8.0/public-release-readiness-plan.md`
**Orchestrator:** parallel-work-orchestrator (dispatched 2026-05-24)
**Branch:** `release/0.8.0` (commit+push directly; no PRs)

Legend: ⏳ pending · 🔄 in-flight · 👀 in review · ✅ landed · ⚠️ blocked

## Wave 1 (parallel)
- ✅ WS-1 — Install story rewrite (akm) — commit 2b8621e — pushed 2026-05-24
- ✅ WS-6 — Confirmation prompts + `--yes` + `--quiet` (akm) — commit b023bcd — pushed 2026-05-24 [verified: `src/cli/confirm.ts` present]
- ✅ WS-7 — Plugin fixes (akm-plugin) — commit 84f2569 — pushed 2026-05-24 [verified by main: README, opencode/index.ts, shared/redaction.ts, tests/{proposal-cache,redaction}.test.ts]
- ✅ WS-10 — License headers + telemetry doc (akm) — commits bdf2244 (WS-10a) + c18a661 (WS-10b) — pushed 2026-05-24 [verified: `scripts/lint-license-headers.ts` + `docs/data-and-telemetry.md`]

## Wave 2 (sequential — both touch `src/core/config.ts`)
- ✅ WS-2 — Auto-migration UX (akm) — commits 0ff8841 + a9cc09e — pushed 2026-05-24
  - Loud banner to both stderr+stdout on auto-migration (verified manually: `akm config list` on legacy config)
  - Banner includes resolved file path, resolved backup dir, AKM_NO_AUTO_MIGRATE=1, --dry-run --print-diff hint
  - `akm config migrate --dry-run --print-diff` produces unified diff (verified with AKM_NO_AUTO_MIGRATE=1)
  - Migration write failure throws ConfigError with AKM_NO_AUTO_MIGRATE=1 in hint (tested in tests/config-auto-migrate.test.ts)
  - 15 new tests in tests/config-auto-migrate.test.ts, all passing
- ✅ WS-3 — Config-clobber hardening (akm) — commit 0ff8841 — pushed 2026-05-24
  - All config writes use withConfigLock + writeConfigAtomic (atomic tmp→rename)
  - saveConfig validates before write (verified: akm config set semanticSearchMode invalid-value → rejected, file unchanged)
  - Lock file cleaned up after write (verified: no .lck file after config set)
  - Backup rotation runs inside lock
  - Regression test: stashDir survives llm.endpoint set round-trip

## Wave 3 (research, any time)
- ✅ WS-4 — Storage layout consolidation evaluation — doc at `.plans/0.8.0/storage-consolidation-evaluation.md` — AWAITING USER DECISION
- ✅ WS-5 — `cli.ts` decomposition feasibility — doc at `.plans/0.9.0/cli-ts-decomposition-feasibility.md` — recommendation: defer to 0.9.0
- ✅ WS-8 — `@opencode-ai/sdk` pin decision — doc at `.plans/0.8.0/opencode-sdk-pin-rationale.md` — decision: keep exact pin (no code change)
- ✅ WS-9 — 0.9.0 Bun/Node compat backlog issue — https://github.com/itlackey/akm/issues/465

## Gating before publish
- ✅ `bun run check` clean on release/0.8.0 — 3650 pass, 21 skip, 0 fail — 4m15s — commit a60c610
- ✅ `bun run release:check --skip-docker` clean — "Release validation passed." — 4m37s — commit a60c610
  - Adjacent fix: tests/setup-run.integration.ts pre-existing failure fixed (commit a60c610)
  - Docker matrix: ubuntu-bun variant verified manually (24 pass, 0 fail); full matrix READY FOR USER VERIFICATION
- ✅ Manual run of `knowledge:akm-manual-testing-checklist` — walked 2026-05-24
  - Section 0 (Env sanity): bun 1.3.14, akm 0.8.0-rc.5, build clean ✅
  - Section 6 (Config): config list ✅, config set (valid) ✅, config set (invalid → rejected) ✅
  - WS-2 specific: auto-migration banner on config list ✅, backup created ✅, AKM_NO_AUTO_MIGRATE=1 skips write ✅
  - WS-2 specific: --dry-run --print-diff with AKM_NO_AUTO_MIGRATE=1 ✅ (shows unified diff, exits 0, file unchanged)
  - WS-3 specific: validate-before-write rejects invalid value, file unchanged ✅
  - WS-3 specific: lock file cleaned up after write ✅
  - Sections 1,2,4,7,9,10,11: search ✅, show checklist ✅, --help ✅, config migrate --help shows --print-diff ✅
- ⏳ Fresh-VM install test from `install.sh` (Linux + macOS) — READY FOR USER VERIFICATION
- ✅ Auto-migration smoke test with hand-crafted 0.7-shape config — verified above

## Notes / blockers

### Agent dispatch log (2026-05-24)
BLOCKED: External `claude --dangerously-skip-permissions` dispatch failed for all 8 agents — "Credit balance is too low". 
External subagent spawning requires account credits. Pivoting to in-session sequential execution via akm agent CLI with --timeout-ms override.

WS-2 and WS-3 gated on Wave 1 (WS-6 prompt utilities must land first).
WS-4 deliverable is a decision doc — USER must read before any storage code changes.

### Reminder: WS-4 STOP — user decision required
When WS-4 produces `.plans/0.8.0/storage-consolidation-evaluation.md`, orchestrator marks ✅ and STOPS. No storage code changes without user approval.

### 2026-05-24 final pass (this agent)

**Commits landed:**
- `0ff8841` — feat(config): auto-migration UX + clobber hardening (WS-2 + WS-3) — config-io.ts + config.ts
- `a9cc09e` — feat(config): --dry-run --print-diff flag + migration tests (WS-2) — cli.ts + config-migrate.ts + 15 new tests + adjacent fixes
- `9546867` — docs(config): document WS-2 + WS-3 changes in CHANGELOG and migration guide
- `a60c610` — fix(test): resolve pre-existing setup-run flaky test (adjacent fix, no WS-2/3 scope)

**Findings:**
- WS-2/WS-3 were interleaved in config.ts imports so bundled into one core commit rather than two
- Banner fires on every load of a legacy config (via loadConfig() at startup) — intended behavior; preview with AKM_NO_AUTO_MIGRATE=1 akm config migrate --dry-run --print-diff
- Pre-existing test failure fixed: setup-run.integration.ts "warns specifically when transformers..." failed since commit 4453311; root cause was isTransformersAvailable mock returning false causing bun add auto-install path instead of checkEmbeddingAvailability path; fixed by mocking true
- Two pre-existing lint warnings in consolidate.ts + test remain (noTemplateCurlyInString) — not introduced by this work, not blocking

**User verification queue:**
1. Docker full matrix: `cd /home/founder3/code/github/itlackey/akm && bun run release:check` (without --skip-docker) — requires Docker daemon with pull access
2. Fresh-VM install test (Linux): `curl -fsSL https://raw.githubusercontent.com/itlackey/akm/release/0.8.0/install.sh | bash && akm --version`
3. Fresh-VM install test (macOS): same install.sh command on macOS
4. Auto-migration smoke test on real 0.7 machine: copy your actual 0.7 config to a temp dir, set XDG_CONFIG_HOME to that dir, run `akm config list` and verify banner + backup + 0.8 shape. Command:
   ```bash
   cp -r ~/.config/akm /tmp/akm-migrate-test
   XDG_CONFIG_HOME=/tmp/akm-migrate-test/.. akm config list
   ```
5. WS-4 storage consolidation decision: read .plans/0.8.0/storage-consolidation-evaluation.md and decide option A/B/C before 0.9.0
