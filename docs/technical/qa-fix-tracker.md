# QA Fix Tracker — manual-qa-2026-04-25

**Last updated**: 2026-04-25 18:00 CDT  
**Source report**: `docs/technical/manual-qa-2026-04-25.md`  
**Branch**: `release/0.6.0`

Each agent assigned to an issue must update its row when state changes:
`pending → in-progress → fixed → tested → reviewed → closed`. Add a line in
the **Notes** column with a commit hash, file path, or test ID once a state
is reached. Do NOT delete rows — closed/won't-fix entries stay in the table
for audit.

---

## Legend

| Field    | Values                                                                |
|----------|-----------------------------------------------------------------------|
| Status   | `pending` `in-progress` `fixed` `tested` `reviewed` `closed` `wont-fix` |
| Severity | `blocker` `major` `minor` `nit`                                        |

---

## Issues (38)

| #  | Title                                                            | Severity | Status         | Owner             | Files / area                                                | Notes                                                                                              |
|----|------------------------------------------------------------------|----------|----------------|-------------------|-------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| 1  | `akm info` does not expose `stashDir`/`configPath`               | minor    | closed (doc)   | checklist-rewrite | `docs/technical/manual-testing-checklist.md`                | Removed from checklist §1; users redirected to `akm init`.                                         |
| 2  | `akm info` reports empty `sourceProviders`                       | major    | fixed          | wave-2-agent      | `src/commands/info.ts`                                      | Synthesises entry from stashDir when sources[] empty. Commit `d5aaf77`. Test: wave2-cluster-e.test.ts. |
| 3  | Fixture stash has extra dirs not listed in §2                    | nit      | closed (doc)   | checklist-rewrite | `docs/technical/manual-testing-checklist.md`                | Updated checklist §2 expected ls.                                                                  |
| 4  | `akm config show` does not exist (was in checklist)              | major    | closed (doc)   | checklist-rewrite | `docs/technical/manual-testing-checklist.md`                | Replaced with `akm config list` everywhere.                                                        |
| 5  | Help text says `(skills.sh)` only — no `context-hub`             | nit      | closed (doc)   | checklist-rewrite | `docs/technical/manual-testing-checklist.md`                | Checklist no longer mentions `context-hub` as a separate component.                                |
| 6  | Search for nonsense token returns fuzzy hits                     | major    | fixed          | wave-2-agent      | `src/indexer/db-search.ts`, `src/core/config.ts`            | minScore floor 0.2 for semantic-only hits. Commit `a586e25`. Test: wave2-cluster-bc.test.ts.       |
| 7  | `akm show <ref> --format json` missing `path`/`editable`         | major    | fixed          | wave-2-agent      | `src/output/output-shapes.ts`                               | path+editable always in base shape. Commit `d5aaf77`. Test: wave2-cluster-e.test.ts.              |
| 8  | Errors emit no `hint` field — only `{ok,error,code}`             | blocker  | fixed          | wave-2-agent      | `src/core/errors.ts`, `src/cli.ts`                          | hint already rendered; added MISSING_REQUIRED_ARGUMENT hint. Commit `55d59ef`. Test: wave2-cluster-d.test.ts. |
| 9  | `akm add <path> --name extra` ignores `--name`                   | major    | fixed          | wave-1-cluster-A  | `src/commands/source-add.ts`                                | `addLocalSource` accepts `explicitName`; honored on duplicate-path too. Commit `38e176c`. Test: source-qa-fixes.test.ts. |
| 10 | Source `kind` reported as `local`, not `filesystem`              | blocker  | fixed          | wave-1-cluster-A  | `src/commands/installed-stashes.ts`, `src/sources/source-types.ts` | `akmListSources` maps `stash.type` directly to `kind`. Commit `38e176c`. Test: source-qa-fixes.test.ts. |
| 11 | Filesystem source defaults to `writable: false` in list          | blocker  | fixed          | wave-1-cluster-A  | `src/commands/installed-stashes.ts`                         | Resolved default true/false applied at list-time. Commit `38e176c`. Test: source-qa-fixes.test.ts. |
| 12 | List output exposes `updatable` field not in spec                | nit      | fixed          | wave-1-cluster-A  | `src/sources/source-types.ts`                               | `updatable` removed from `SourceEntry` and list code. Commit `38e176c`.                            |
| 13 | All errors exit `78` (CONFIG) regardless of class                | major    | fixed          | wave-2-agent      | `src/cli.ts` classifyExitCode                               | Already correct; regression guard added. Commit `55d59ef`. Test: wave2-cluster-d.test.ts.          |
| 14 | `akm search` (no query) returns hits instead of erroring         | major    | fixed          | wave-2-agent      | `src/cli.ts` searchCommand                                  | CLI guard; akmSearch() itself still accepts empty for programmatic list-all. Commit `a586e25`.     |
| 15 | `akm show foo` returns `INVALID_FLAG_VALUE` instead of UsageError | major   | fixed          | wave-2-agent      | `src/core/asset-ref.ts`                                     | parseAssetRef uses MISSING_REQUIRED_ARGUMENT; hint added. Commit `55d59ef`. Test: wave2-cluster-d.test.ts. |
| 16 | `config set sources <bad>` error says "stashes"                  | major    | fixed          | wave-2-agent      | `src/commands/config-cli.ts` parseStashesValue              | Messages updated to "sources" / "sources[N]". Commit `55d59ef`. Test: wave2-cluster-d.test.ts.    |
| 17 | Website source `kind` is `remote`, not `website`                 | blocker  | fixed          | wave-1-cluster-A  | `src/commands/installed-stashes.ts`, `src/sources/source-types.ts` | Same fix as #10. Commit `38e176c`. Test: source-qa-fixes.test.ts.                                  |
| 18 | `--name` flag honored on website but dropped for filesystem      | major    | fixed          | wave-1-cluster-A  | `src/commands/source-add.ts`                                | Same fix as #9. Commit `38e176c`. Test: source-qa-fixes.test.ts.                                   |
| 19 | `akm update docs-site` fails: website is "remote-only"           | major    | fixed          | wave-1-cluster-A  | `src/commands/installed-stashes.ts`                         | `akmUpdate` calls `ensureWebsiteMirror({force:true})` for website sources. Commit `38e176c`.       |
| 20 | `akm remember --description` not persisted in frontmatter        | major    | fixed          | wave-2-agent      | `src/cli.ts` rememberCommand                                | Added --description arg; passed to buildMemoryFrontmatter. Commit `d5aaf77`. Test: wave2-cluster-e.test.ts. |
| 21 | `defaultWriteTarget` cannot be set via `akm config set`          | blocker  | fixed          | wave-2-agent      | `src/commands/config-cli.ts`, `src/core/config.ts`          | Full parse/get/set/unset/list support. Commit `a586e25`. Test: wave2-cluster-bc.test.ts.           |
| 22 | `--target <name>` requires source name (which is the path today) | major    | fixed          | wave-1-cluster-A  | downstream of #9                                            | Closed when #9 landed. Commit `38e176c`.                                                           |
| 23 | `akm list` reports `writable:false` but writes succeed           | major    | fixed          | wave-1-cluster-A  | `src/commands/installed-stashes.ts`                         | Closed alongside #11. Commit `38e176c`.                                                            |
| 24 | `akm curate ""` returns hits instead of UsageError               | major    | fixed          | wave-2-agent      | `src/commands/curate.ts` akmCurate                          | Guard in akmCurate itself (not just CLI). Commit `a586e25`. Test: wave2-cluster-bc.test.ts.        |
| 25 | `akm curate` JSON shape uses `.items`, not `.assets`             | nit      | closed (doc)   | checklist-rewrite | checklist                                                   | Updated to reference `.items`.                                                                     |
| 26 | `akm clone` flag is `--dest`, not `--to`                         | major    | closed (doc)   | checklist-rewrite | checklist                                                   | Updated to use `--dest`. CLI behavior is correct.                                                  |
| 27 | `akm clone <missing>` error leaks "Stash type root"              | minor    | fixed          | wave-2-agent      | `src/sources/source-resolve.ts`                             | User-facing messages + hints. Commit `55d59ef`. Test: wave2-cluster-d.test.ts.                     |
| 28 | `registry search` `--detail brief` returns `[{}, ...]`           | major    | fixed          | wave-2-agent      | `src/output/output-shapes.ts` shapeSearchHit                | Brief now projects name+installRef+score. Commit `d5aaf77`. Test: wave2-cluster-e.test.ts.         |
| 29 | `akm registry add-kit` does not exist (in checklist)             | minor    | closed (doc)   | checklist-rewrite | checklist                                                   | Removed; users use `akm add <installRef>`.                                                         |
| 30 | Registry search wrapper key is `hits`, not `kits`                | nit      | closed (doc)   | checklist-rewrite | checklist                                                   | Naming is consistent across CLI; updated checklist.                                                |
| 31 | `workflow show` / `workflow run --dry-run` do not exist          | major    | closed (doc)   | checklist-rewrite | checklist                                                   | Replaced with `start` + `status` + `next`.                                                         |
| 32 | Workflow markdown spec stricter than `# Workflow:` heading       | minor    | closed (doc)   | checklist-rewrite | checklist                                                   | Now points users at `akm workflow template`.                                                       |
| 33 | `akm wiki remove` requires `--force`                             | minor    | closed (doc)   | checklist-rewrite | checklist                                                   | Added `--force` to checklist; CLI behavior is correct.                                             |
| 34 | `akm vault add` / `vault remove` do not exist                    | major    | closed (doc)   | checklist-rewrite | checklist                                                   | Replaced with `create`/`set`/`unset` workflow.                                                     |
| 35 | Vault list `comments[]` is parallel array, not key→comment map   | minor    | fixed          | wave-2-agent      | `src/commands/vault.ts`, `src/cli.ts`                       | New listEntries(); output shape is entries:[{key,comment}]. Commit `d5aaf77`. Test: wave2-cluster-e.test.ts. |
| 36 | `config set llm.endpoint <url>` rejected                         | major    | fixed          | wave-2-agent      | `src/commands/config-cli.ts`                                | llm.*/embedding.* subkeys with deep-merge. Commit `a586e25`. Test: wave2-cluster-bc.test.ts.       |
| 37 | `akm config edit` does not exist                                 | minor    | closed (doc)   | checklist-rewrite | checklist                                                   | Removed from checklist; not a real command.                                                        |
| 38 | Migration/error hints reference non-existent subcommands         | major    | fixed          | wave-2-agent      | `src/core/config.ts`, `src/core/write-source.ts`            | Real commands: `akm remove`, config file path. Commit `55d59ef`. Test: wave2-cluster-d.test.ts.    |

---

## Roll-up

- **Closed (doc-only, fixed by checklist rewrite)**: 13 (#1, #3, #4, #5, #25, #26, #29, #30, #31, #32, #33, #34, #37)
- **Fixed by Cluster A (wave-1, commit `38e176c`)**: 9 (#9, #10, #11, #12, #17, #18, #19, #22, #23)
- **Fixed by wave-2 Cluster B (commit `a586e25`)**: 2 (#21, #36)
- **Fixed by wave-2 Cluster C (commit `a586e25`)**: 3 (#6, #14, #24)
- **Fixed by wave-2 Cluster D (commit `55d59ef`)**: 6 (#8, #13, #15, #16, #27, #38)
- **Fixed by wave-2 Cluster E (commit `d5aaf77`)**: 5 (#2, #7, #20, #28, #35)
- **Total fixed**: 38 (all issues addressed)
- **Remaining pending**: 0

---

## Activity log

- 2026-04-25 11:55 — tracker created; 13 doc-only issues closed by `manual-testing-checklist.md` rewrite.
- 2026-04-25 12:25 — Wave 1 complete:
  - Cluster A (commit `38e176c`, landed on `release/0.6.0`): #9, #10, #11, #12, #17, #18, #19, #22, #23 fixed. 1763/1770 tests pass.
  - Cluster B (worktree `agent-a84ca59f`, commit `dbbe221`): #21, #36 fixed BUT worktree was off a stale base (`7c72dd5`, 0.5.0-era). Diff targets `src/config.ts` / `src/config-cli.ts`; needs porting to `src/core/config.ts` / `src/commands/config-cli.ts` on `release/0.6.0`.
  - Cluster C (worktree `agent-a9a00227`, commit `d21bbc7`): #6, #14, #24 fixed. Same stale-base problem. Diff targets `src/cli.ts`, `src/config.ts`, `src/local-search.ts`; needs porting to current layout.
- 2026-04-25 12:30 — Wave 2 dispatched (single in-place agent): port B + C, implement D + E.
- 2026-04-25 18:00 — Wave 2 complete (wave-2-agent):
  - Cluster B (commit `a586e25`): #21 (defaultWriteTarget), #36 (llm.*/embedding.* subkeys) ported to current layout. 34 new tests.
  - Cluster C (commit `a586e25`): #6 (minScore floor 0.2 in db-search.ts), #14 (CLI search guard), #24 (akmCurate guard). 3 new tests (curate path). search.minScore added to AkmConfig.
  - Cluster D (commit `55d59ef`): #8 (hint regression guard), #13 (exit-code regression guard), #15 (MISSING_REQUIRED_ARGUMENT code + hint), #16 ("sources" in error messages), #27 (user-facing source-resolve messages + hints), #38 (real commands in deprecation/openviking hints). 19 new tests.
  - Cluster E (commit `d5aaf77`): #2 (stashDir → sourceProviders fallback), #7 (path+editable always in show JSON), #20 (--description flag added to remember), #28 (registry brief: name+installRef+score), #35 (vault entries:[{key,comment}]). 20 new tests.
  - Final test suite: 1835 pass, 7 skip, 0 fail (1842 total).
