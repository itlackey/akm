# Bug: `akm setup --yes --dir .` writes to user's global config even with `AKM_STASH_DIR` set

**Discovered:** 2026-05-23
**AKM version:** 0.8.0-rc.4 (`release/0.8.0` @ 0e1d339)
**Severity:** High — silent corruption of user's global config; only detectable by explicit `akm config get stashDir` check.

## Summary

`akm setup --yes --dir .` writes its resulting config to the user's **global** `~/.config/akm/config.json` even when `AKM_STASH_DIR` and `AKM_DATA_DIR` env vars are exported to point at a temp directory. The env isolation correctly redirects stash and data file paths but does **not** redirect config persistence. When a test harness or smoke-test script then removes the temp stash, the user's global config is left with `stashDir` pointing at a deleted path. AKM silently falls back to `~/akm` for stash operations so the breakage is invisible to the user until they explicitly inspect the config.

## Reproduction

```bash
# Confirm starting state
akm config get stashDir
# → "/home/founder3/akm"

# Run a setup smoke test in an isolated temp stash
cd /tmp && rm -rf repro-stash && mkdir -p repro-stash && cd repro-stash && \
  AKM_DATA_DIR=$(pwd)/data AKM_STASH_DIR=$(pwd) \
  bun /path/to/akm/dist/cli.js setup --yes --dir .

# Re-check the global config from the user's shell
akm config get stashDir
# → "/tmp/repro-stash"   ← BUG: env-isolated setup leaked into global config

# Worse, after cleanup:
cd / && rm -rf /tmp/repro-stash
akm config get stashDir
# → "/tmp/repro-stash"   ← still pointing at a deleted dir
akm improve  # silently falls back to ~/akm; user has no idea config is broken
```

## Real-world impact (incident on this machine)

A parallel Claude Code session (sessionId `e702fb7d-1095-42a7-98eb-e71974457c77`, working in `~/code/github/itlackey/akm/` on the 0.8.0 release-readiness audit) ran:

```bash
# 06:28:35Z
cd /tmp && rm -rf tw-stash && mkdir -p tw-stash && cd tw-stash && \
  AKM_DATA_DIR=$(pwd)/data AKM_STASH_DIR=$(pwd) \
  /home/founder3/code/github/itlackey/akm/dist/cli.js setup --yes --dir .

# 06:28:48Z
cd /tmp/tw-stash && rm -rf data .akm; \
  AKM_DATA_DIR=$(pwd)/data AKM_STASH_DIR=$(pwd) \
  bun /home/founder3/code/github/itlackey/akm/dist/cli.js setup --yes --dir .

# 06:34:29Z
rm -rf /tmp/tw-stash && echo "cleaned"
```

Result: the user's `~/.config/akm/config.json` was rewritten with `stashDir: "/tmp/tw-stash"`, the entire `llm` block was dropped, all 4 `profiles.llm.*` entries (qwen-9b/ministral-3b/gemma-e4b/default) were lost, `profiles.improve.default.processes` lost `consolidate` and `feedbackDistillation`, the `defaults` block was lost, and `configVersion` was dropped. Setup *also* added `index.stalenessDetection` defaults and `profiles.agent.opencode` (= `github-copilot/gpt-5-mini`).

The breakage was silent for ~5.5 hours until a memory write returned `"stashRoot": "/home/founder3/akm"` despite the configured `stashDir` being `/tmp/tw-stash`, prompting investigation.

## Forensic trail

Two consecutive `saveConfig()` backups exist 6ms apart, confirming a single-process write:

```text
~/.cache/akm/config-backups/config-2026-05-23T06-28-48-123Z.json  ← 12,279 bytes, stashDir: /home/founder3/akm  (healthy)
~/.cache/akm/config-backups/config-2026-05-23T06-28-48-129Z.json  ← 12,274 bytes, stashDir: /tmp/tw-stash         (broken)
```

The canonical attribution log for cross-session investigation is `~/.local/state/akm-claude/events.jsonl` — it captures one `tool_observation` event per Bash call, per session, including sessionId, timestamp, and full command. Grep for any suspect literal (e.g. `tw-stash`) to find the originating session and command.

## Root cause

`src/setup/setup.ts` calls `saveConfig(...)` at lines 1842, 1971, and 2082. `saveConfig` (in `src/core/config.ts:956+`) writes to the path returned by the config-path resolver, which honors `XDG_CONFIG_HOME` but **not** `AKM_STASH_DIR`. So when the user sets `AKM_STASH_DIR=/tmp/X` and `AKM_DATA_DIR=/tmp/X/data` (which is the documented isolation pattern, e.g. in `scripts/akm-eval/src/sources/sandbox.ts`), config writes still target the host's `~/.config/akm/config.json`.

There is a guard in `src/commands/init.ts:41-46` that *refuses* `/tmp/*`, `/var/tmp/*`, `/private/tmp/*` as a stashDir — but that guard applies to `akm init`, not to `akm setup`.

The companion bug: `~/.cache/akm/config-backups/` is also not isolated. The 32-byte backups created at minute-marks throughout the day (e.g. `config-2026-05-23T05-15-30-150Z.json` = `{"agent":{"default":"opencode"}}`) prove that any subprocess `saveConfig({minimal})` writes to the user's cache regardless of env isolation. This pollutes the backup directory and makes legitimate backups hard to find.

## Proposed fixes

1. **Honor `AKM_STASH_DIR` in `saveConfig`.** When `AKM_STASH_DIR` is set and points at a directory the process can write to, write config to `$AKM_STASH_DIR/config.json` (or under `$AKM_STASH_DIR/.akm/config.json`) instead of the host's global config. This is the same pattern the data dir already uses for `state.db` etc.
2. **Apply the `init.ts` tmp-guard to `setup`.** `src/commands/init.ts:41-46` refuses `stashDir.startsWith("/tmp/")`. The same refusal should apply in `setup` unless `--force` is passed. This prevents *any* setup invocation from persisting a `/tmp/...` stashDir to the user's global config.
3. **Add `--config-out <path>` to `akm setup`.** Explicit redirection for test harnesses that intentionally want their own config file.
4. **Add `akm doctor` health check.** A new subcommand (or extension of `akm health`) that verifies: `stashDir` is readable; `stashDir` parent exists; `stashDir` matches what `akm info` reports as `stashRoot`. Suggests `mv -fv ~/.cache/akm/config-backups/config-<largest-pre-incident>.json ~/.config/akm/config.json` when corruption is detected.
5. **Isolate `~/.cache/akm/config-backups/`.** The backup write path must honor `XDG_CACHE_HOME` and/or `AKM_CACHE_DIR`. Currently any subprocess `saveConfig()` pollutes the host's backup dir.
6. **Print a stark warning when `AKM_STASH_DIR` is set but config persistence is not redirected.** Until fix #1 lands, at minimum `setup` should warn: `"WARNING: AKM_STASH_DIR=$X is set, but config will be written to $HOST_CONFIG. Pass --config-out to redirect, or fix #N."`

## Recovery procedure for users hit by this bug

```bash
# 1. Diagnose
akm config get stashDir
grep STASH_DIR_UNREADABLE ~/.cache/akm/tasks/logs/akm-improve.log | head -3

# 2. Find the largest pre-incident backup
ls -lat ~/.cache/akm/config-backups/config-*.json | awk '$5 > 5000 {print}' | head -5

# 3. Restore (use mv, not rm, so the broken config is preserved)
mv -v ~/.config/akm/config.json ~/.config/akm/config.broken-$(date +%Y%m%d-%H%M).json
mv -v ~/.cache/akm/config-backups/config-<largest>.json ~/.config/akm/config.json

# 4. Verify
akm config get stashDir
akm config list | jq '{stashDir, llm, defaults, profiles: .profiles | keys}'
```

AKM auto-migrates older schemas on first read after restore.

## Related

- `src/setup/setup.ts:1842,1971,2082` — `saveConfig` call sites in setup
- `src/core/config.ts:956+` — `saveConfig` implementation (config-path resolver)
- `src/commands/init.ts:41-46` — existing `/tmp/*` guard (not applied to setup)
- `scripts/akm-eval/src/sources/sandbox.ts` — correct env-isolation pattern for stash + data; sets `HOME=root` precisely to dodge this category of leakage
- `~/.local/state/akm-claude/events.jsonl` — multi-session Bash command log used for attribution
