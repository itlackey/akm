# QA Fix Tracker — manual-qa-2026-04-25

**Last updated**: 2026-04-25 11:55 CDT  
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
| 2  | `akm info` reports empty `sourceProviders`                       | major    | pending        |                   | `src/commands/info.ts`                                      | Either populate the array from the provider registry or remove the field.                         |
| 3  | Fixture stash has extra dirs not listed in §2                    | nit      | closed (doc)   | checklist-rewrite | `docs/technical/manual-testing-checklist.md`                | Updated checklist §2 expected ls.                                                                  |
| 4  | `akm config show` does not exist (was in checklist)              | major    | closed (doc)   | checklist-rewrite | `docs/technical/manual-testing-checklist.md`                | Replaced with `akm config list` everywhere.                                                        |
| 5  | Help text says `(skills.sh)` only — no `context-hub`             | nit      | closed (doc)   | checklist-rewrite | `docs/technical/manual-testing-checklist.md`                | Checklist no longer mentions `context-hub` as a separate component.                                |
| 6  | Search for nonsense token returns fuzzy hits                     | major    | pending        |                   | semantic ranker; `src/commands/search.ts`                   | Add minScore floor or require ≥1 FTS row to surface results.                                       |
| 7  | `akm show <ref> --format json` missing `path`/`editable`         | major    | pending        |                   | `src/output/show*` shape                                    | Project the resolved file path and writable status.                                                |
| 8  | Errors emit no `hint` field — only `{ok,error,code}`             | blocker  | pending        |                   | `src/core/errors.ts`, `src/output/errors*`                  | Some errors DO carry hints (writable rejection); not-found does not. Renderer drops `error.hint()`. |
| 9  | `akm add <path> --name extra` ignores `--name`                   | major    | pending        |                   | `src/commands/add.ts`, filesystem provider config write     | Persist `--name` for filesystem like it does for website.                                          |
| 10 | Source `kind` reported as `local`, not `filesystem`              | blocker  | pending        |                   | `src/sources/filesystem.ts`, `src/commands/list.ts`         | Locked v1 contract violation.                                                                      |
| 11 | Filesystem source defaults to `writable: false` in list          | blocker  | pending        |                   | `src/commands/list.ts`, source-config resolver              | Render the resolved default (true on filesystem) instead of the raw stored value.                  |
| 12 | List output exposes `updatable` field not in spec                | nit      | pending        |                   | `src/commands/list.ts`                                      | Either document in `SourceConfigEntry` or drop.                                                    |
| 13 | All errors exit `78` (CONFIG) regardless of class                | major    | pending        |                   | `src/cli.ts` exit-code mapping; error classes                | UsageError → 2, ConfigError → 78, everything else → 1.                                             |
| 14 | `akm search` (no query) returns hits instead of erroring         | major    | pending        |                   | `src/commands/search.ts`                                    | Hard-fail with UsageError on empty/missing query.                                                  |
| 15 | `akm show foo` returns `INVALID_FLAG_VALUE` instead of UsageError | major   | pending        |                   | `src/commands/show.ts` ref parser                           | Throw `UsageError` (code `USAGE`) for malformed refs.                                              |
| 16 | `config set sources <bad>` error says "stashes"                  | major    | pending        |                   | `src/commands/config-cli.ts` parseConfigValue               | Update message to reference `sources` (or both, but lead with `sources`).                          |
| 17 | Website source `kind` is `remote`, not `website`                 | blocker  | pending        |                   | `src/sources/website.ts`, `src/commands/list.ts`            | Same family as #10.                                                                                |
| 18 | `--name` flag honored on website but dropped for filesystem      | major    | pending        |                   | `src/commands/add.ts`                                       | Resolve together with #9.                                                                          |
| 19 | `akm update docs-site` fails: website is "remote-only"           | major    | pending        |                   | `src/sources/website.ts` (sync method); update command       | Wire the website provider's mirror into `update`.                                                  |
| 20 | `akm remember --description` not persisted in frontmatter        | major    | pending        |                   | `src/commands/remember.ts`                                  | Write `description:` to frontmatter when flag present.                                             |
| 21 | `defaultWriteTarget` cannot be set via `akm config set`          | blocker  | pending        |                   | `src/commands/config-cli.ts`                                | Add to parse/get/set/unset switches.                                                               |
| 22 | `--target <name>` requires source name (which is the path today) | major    | pending        |                   | downstream of #9                                            | Closes when #9 lands.                                                                              |
| 23 | `akm list` reports `writable:false` but writes succeed           | major    | pending        |                   | `src/commands/list.ts` rendering                            | Closes alongside #11.                                                                              |
| 24 | `akm curate ""` returns hits instead of UsageError               | major    | pending        |                   | `src/commands/curate.ts`                                    | Same pattern as #14.                                                                               |
| 25 | `akm curate` JSON shape uses `.items`, not `.assets`             | nit      | closed (doc)   | checklist-rewrite | checklist                                                   | Updated to reference `.items`.                                                                     |
| 26 | `akm clone` flag is `--dest`, not `--to`                         | major    | closed (doc)   | checklist-rewrite | checklist                                                   | Updated to use `--dest`. CLI behavior is correct.                                                  |
| 27 | `akm clone <missing>` error leaks "Stash type root"              | minor    | pending        |                   | `src/commands/clone.ts` or asset lookup                     | Replace with user-facing wording + add hint.                                                       |
| 28 | `registry search` `--detail brief` returns `[{}, ...]`           | major    | pending        |                   | `src/output/registry-search*` brief renderer                | Project `name` + `installRef` + `score` at minimum.                                                |
| 29 | `akm registry add-kit` does not exist (in checklist)             | minor    | closed (doc)   | checklist-rewrite | checklist                                                   | Removed; users use `akm add <installRef>`.                                                         |
| 30 | Registry search wrapper key is `hits`, not `kits`                | nit      | closed (doc)   | checklist-rewrite | checklist                                                   | Naming is consistent across CLI; updated checklist.                                                |
| 31 | `workflow show` / `workflow run --dry-run` do not exist          | major    | closed (doc)   | checklist-rewrite | checklist                                                   | Replaced with `start` + `status` + `next`.                                                         |
| 32 | Workflow markdown spec stricter than `# Workflow:` heading       | minor    | closed (doc)   | checklist-rewrite | checklist                                                   | Now points users at `akm workflow template`.                                                       |
| 33 | `akm wiki remove` requires `--force`                             | minor    | closed (doc)   | checklist-rewrite | checklist                                                   | Added `--force` to checklist; CLI behavior is correct.                                             |
| 34 | `akm vault add` / `vault remove` do not exist                    | major    | closed (doc)   | checklist-rewrite | checklist                                                   | Replaced with `create`/`set`/`unset` workflow.                                                     |
| 35 | Vault list `comments[]` is parallel array, not key→comment map   | minor    | pending        |                   | `src/commands/vault.ts` list output                         | Optional: change shape to `entries:[{key,comment}]`.                                               |
| 36 | `config set llm.endpoint <url>` rejected                         | major    | pending        |                   | `src/commands/config-cli.ts`                                | Add subkey support for `llm.*` and `embedding.*`.                                                  |
| 37 | `akm config edit` does not exist                                 | minor    | closed (doc)   | checklist-rewrite | checklist                                                   | Removed from checklist; not a real command.                                                        |
| 38 | Migration/error hints reference non-existent subcommands         | major    | pending        |                   | source string for stashes-deprecation + openviking errors    | Replace `akm config edit` and `akm config sources remove` with real commands.                      |

---

## Roll-up

- **Closed (doc-only, fixed by checklist rewrite)**: 13 (#1, #3, #4, #5, #25, #26, #29, #30, #31, #32, #33, #34, #37)
- **Pending code fixes**: 25 (#2, #6–#24 minus the closed ones, #27, #28, #35, #36, #38)
  - Blockers: 5 (#8, #10, #11, #17, #21)
  - Majors: 16 (#2, #6, #7, #9, #13, #14, #15, #16, #18, #19, #20, #22, #23, #24, #28, #36, #38)
  - Minors: 3 (#12, #27, #35)
- **Owner queue**: open

---

## Activity log

- 2026-04-25 11:55 — tracker created; 13 doc-only issues closed by `manual-testing-checklist.md` rewrite.
- 2026-04-25 12:25 — Wave 1 complete:
  - Cluster A (commit `38e176c`, landed on `release/0.6.0`): #9, #10, #11, #12, #17, #18, #19, #22, #23 fixed. 1763/1770 tests pass.
  - Cluster B (worktree `agent-a84ca59f`, commit `dbbe221`): #21, #36 fixed BUT worktree was off a stale base (`7c72dd5`, 0.5.0-era). Diff targets `src/config.ts` / `src/config-cli.ts`; needs porting to `src/core/config.ts` / `src/commands/config-cli.ts` on `release/0.6.0`.
  - Cluster C (worktree `agent-a9a00227`, commit `d21bbc7`): #6, #14, #24 fixed. Same stale-base problem. Diff targets `src/cli.ts`, `src/config.ts`, `src/local-search.ts`; needs porting to current layout.
- 2026-04-25 12:30 — Wave 2 dispatched (single in-place agent): port B + C, implement D + E.
