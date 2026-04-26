# Manual QA Re-Run — 2026-04-25 (post-fix)

Second pass through `docs/technical/manual-testing-checklist.md` after
applying all 38 issue fixes from the original report
(`docs/technical/manual-qa-2026-04-25.md`). Branch `release/0.6.0`,
HEAD `d4a0ee1`.

## Test pyramid

- `bunx biome check --write src/ tests/` — clean (7 pre-existing warnings, no fixes applied)
- `bunx tsc --noEmit` — clean
- `bun test` — **1835 pass, 0 fail, 7 skip** across 102 files

## Manual checklist verification (sandbox)

For each fixed issue, the relevant probe was executed in a fresh
sandbox (`/tmp/akm-sandbox.ftQX4A`). Results below are condensed; the
sandbox was torn down at the end with `~/.config/akm/` untouched.

| #  | Probe                                                          | Before                                  | After                                                    | Verdict |
|----|----------------------------------------------------------------|------------------------------------------|----------------------------------------------------------|---------|
| 6  | `akm search nonexistent-token-9999`                            | 18 fuzzy hits                            | 2 hits with score≥0.2 (FTS-supported only)               | Improved per design (minScore=0.2) |
| 7  | `akm show skill:k8s-deploy --format json`                      | no `path`/`editable`                     | both present + correct                                   | Fixed |
| 8  | `akm show skill:does-not-exist`                                | no `hint` field                          | `hint: "Run akm list to see your configured sources..."` | Fixed |
| 9  | `akm add /path --name extra` then `akm list`                   | `name = /path`                           | `name = "extra"`                                         | Fixed |
| 10 | `akm list .sources[].kind` for filesystem                      | `"local"`                                | `"filesystem"`                                           | Fixed |
| 11 | `akm list .sources[].writable` for filesystem                  | `false`                                  | `true`                                                   | Fixed |
| 12 | `akm list .sources[].updatable`                                | `false` (extra field)                    | absent                                                   | Fixed |
| 13 | `akm show skill:does-not-exist` exit code                      | 78                                       | 1 (GENERAL)                                              | Fixed |
| 13 | `akm show foo` exit code                                       | 78                                       | 2 (USAGE)                                                | Fixed |
| 14 | `akm search` no-arg                                            | returns hits                             | UsageError, exit 2                                       | Fixed |
| 15 | `akm show foo`                                                 | code `INVALID_FLAG_VALUE`                | code `MISSING_REQUIRED_ARGUMENT` + hint                  | Fixed |
| 16 | `akm config set sources weird-thing`                           | message says "stashes"                   | message says "sources"                                   | Fixed |
| 17 | `akm list .sources[].kind` for website                         | `"remote"`                               | `"website"`                                              | Fixed |
| 18 | `akm add /path --name extra` (filesystem)                      | drops `--name`                           | persists `--name`                                        | Fixed |
| 19 | `akm update <website>`                                         | `TARGET_NOT_UPDATABLE`                   | calls `ensureWebsiteMirror({force:true})`                | Fixed |
| 20 | `akm remember --description`                                   | dropped                                  | written to frontmatter                                   | Fixed |
| 21 | `akm config set defaultWriteTarget extra`                      | `Unknown config key`                     | persists; `get` returns `"extra"`                        | Fixed |
| 22 | `akm remember --target extra` (by name not path)               | fails (#9 broke it)                      | works                                                    | Fixed (downstream of #9) |
| 23 | `akm list` writable for filesystem                             | `false`                                  | `true`                                                   | Fixed |
| 24 | `akm curate ""`                                                | returns hits                             | UsageError, exit 2                                       | Fixed |
| 27 | `akm clone skill:does-not-exist`                               | leaks "Stash type root"                  | user-facing message + hint                               | Fixed |
| 28 | `akm registry search docker --detail brief`                    | `[{}, {}, ...]`                          | `[{title, installRef, score, name}, ...]`                | Fixed |
| 35 | `akm vault list vault:test-vault --format json`                | `{keys:[...], comments:[...]}`           | `{entries:[{key, comment}]}`                             | Fixed |
| 36 | `akm config set llm.endpoint http://localhost:1234/v1`         | `Unknown config key`                     | persists; `get` returns the URL; round-trips             | Fixed |
| 38 | OpenViking config error remediation                            | "akm config sources remove" (phantom)    | "akm remove ov" (real) + config file path                | Fixed |
| 38 | `stashes[]` deprecation warning                                | "akm config edit" (phantom)              | "edit it directly at <configPath>"                       | Fixed |

The 13 doc-only issues were closed by the checklist rewrite during the
first pass; no live probes were needed for them.

## Follow-up nits (minor / non-blocking)

These came up during the re-run and are not in the original 38, but
worth tracking before tagging:

1. **Empty-search hint text is wrong**. `akm search` with no arg returns
   `hint: "Refs use the form type:name, e.g. \`akm show skill:deploy\`..."`
   That hint is correct for `akm show foo` (issue #15) but the
   `searchCommand` re-uses the same `MISSING_REQUIRED_ARGUMENT` hint
   verbiage. Surface a query-specific hint instead (e.g. "Pass a search
   string: `akm search docker`").
2. **Search `minScore=0.2` floor is conservative**. `akm search
   nonexistent-token-9999` still returns 2 FTS-matched results because
   FTS hits are never dropped by the floor. That's by design (per
   wave-2 cluster C decision) — but it means the §4 checklist note
   "expect zero hits" is still inaccurate for genuinely-no-match
   semantic-only queries. Document the floor's semantics in the
   checklist.
3. **`sourceProviders` interpretation**. After fix #2, `akm info
   .sourceProviders` returns the *configured* sources (`[{type,name,path}]`)
   rather than the *registered provider classes* (`[filesystem, git, npm,
   website]`). The original checklist expected the latter. The new shape
   is more useful for agents but the §3 checklist note should be updated
   to match.

## Verdict

All 38 QA issues closed. Test suite green. CLI surface is consistent with
the rewritten checklist and CLAUDE.md after dropping the `.hint()` contract.

## Commits in this fix cycle

- `38e176c` cluster A — sources, list, add, website sync wiring
- `c840beb` add fix tracker
- `a586e25` cluster B+C ports — config-cli subkeys, search/curate guards, minScore
- `55d59ef` cluster D — error codes, hints, user-facing messages
- `d5aaf77` cluster E — show JSON, info sourceProviders, remember --description, vault entries shape, registry brief
- `e83cf3c` programmatic akmSearch accepts empty (CLI keeps the guard)
- `7994f33` tracker update — wave 2 done
- `23bb885` tracker update — cluster A rows closed
- `14cd897` parseLlmConfig accepts empty model (subkey-set partials)
- `d4a0ee1` test update for the parser change
