# Classification

akm recognizes files through **bundle adapters**. An adapter owns one bundle
format. Its `recognize()` method inspects one file (path, frontmatter, content)
and returns an `IndexDocument` (the item's subdirectory-qualified `conceptId`,
type, renderer, and metadata) or `null` when the adapter does not claim the
file. The indexer calls it for every file the walker finds (see
[Indexing](indexing.md)).

## Built-in adapters

`BUILTIN_ADAPTERS` in `src/core/adapter/adapters/index.ts` is a frozen list,
exposed through `src/core/adapter/registry.ts`. Its order is the install-time
probe order, and `ADAPTER_ID_TABLE` (`src/core/adapter/adapter-ids.ts`) mirrors
it. There are eleven:

| Adapter id | Format | Recognizes |
| --- | --- | --- |
| `website-snapshot` | Crawled website snapshot (read-only) | pages under `stash/knowledge/` that carry the `website` tag or a `sourceUrl`, typed `website` |
| `agent-skills` | Collection of `<name>/SKILL.md` packages | one `skill` per package directory; bundled resources belong to the skill |
| `claude` | A `.claude/` tool directory | root `CLAUDE.md` (`instruction`), `commands/`, `agents/`, `skills/<name>/SKILL.md`; skips `settings.json` and `.mcp.json` |
| `opencode` | An `.opencode/` tool directory | root `AGENTS.md` (`instruction`), `commands/`, `agents/`, `skills/<name>/SKILL.md`; skips `opencode.json` |
| `dotenv` | Env-file bundle | `env/*.env` as `env` (key names only) and any file under `secrets/` as `secret` (name only) |
| `akm-workflow` | Workflow bundle | `.md` workflow sources |
| `akm-task` | Task bundle | `.yml` task sources as `task`; `.yaml` is not recognized |
| `llm-wiki` | LLM Wiki bundle | a root with `schema.md` and `pages/`: pages (type from frontmatter `pageKind`, default `note`) and `raw/` sources (`wiki-source`) |
| `akm` | The AKM bundle layout | the types listed under "Item types" below |
| `okf` | Open Knowledge Format bundle | any `.md` except `index.md` and `log.md`; `type` comes from frontmatter, default `knowledge`; the directory does not change it |
| `generic-files` | Catch-all mount | scripts as `script`, `.md`/`.txt` as `document`, everything else as `file` |

The first adapter whose `looksLikeRoot` probe matches a root claims it, and the
winner is recorded per component. A root matching no probe falls back to `akm`
(`FALLBACK_ADAPTER_ID`, `src/indexer/installations.ts`). `generic-files` is not
probed. An adapter set in a bundle's config entry (`components.<name>.adapter`,
validated against the ids above) wins over probing. The probe order puts
`claude`, `opencode`, and `dotenv` ahead of `akm`, and `akm` ahead of `okf`,
because AKM Markdown is an OKF-compatible superset.

[Bundle Types](../../reference/bundle-types.md) has the user-facing detail per
adapter: conceptId shape, what is indexed, `validate()` checks, and whether the
adapter can write.

## Item types

`type` is an open string. The core accepts every non-empty value, and the owning
adapter decides whether a value gets specialized behavior. The `akm` adapter
emits fourteen types (`KNOWN_TYPES`, `src/core/recognition-util.ts`): `skill`,
`command`, `agent`, `knowledge`, `workflow`, `script`, `memory`, `env`, `secret`,
`lesson`, `task`, `session`, `fact`, `instruction`. See
[Asset Types](../../reference/asset-types.md).

`wiki` is not an item type; multi-page wikis are a bundle format owned by the
`llm-wiki` adapter.

## Reserved and skipped files

`index.md` and `log.md` are reserved at every depth and are not items
(`RESERVED_FILES`, `src/core/adapter/adapters/shared.ts`). The `akm` adapter also
skips, using path and `stat` checks (`akmStashAbstains`,
`src/core/adapter/adapters/akm-adapter.ts`):

- the bundle's root `README.md`;
- an `env/` `.env` file with a sibling `.sensitive` marker;
- a `secrets/` file that is a `.sensitive` or `.lock` marker, or that has a sibling `<name>.sensitive` marker;
- the root-level `schema.md`, `index.md`, and `log.md` of a `wikis/<name>/` directory.

The walker itself skips VCS internals. It indexes a symlink to a file like any other file and never descends a symlinked directory.

## How the akm adapter picks a type

The `akm` adapter runs four matchers from `src/indexer/walk/matchers.ts`
(`extensionMatcher`, `directoryMatcher`, `parentDirHintMatcher`,
`smartMdMatcher`). `recognizeMatch` (`src/core/adapter/recognize-match.ts`)
collects their results and picks the highest specificity. On a tie the matcher
registered later wins, in the order listed.

| Specificity | Signal | Type |
| --- | --- | --- |
| 25 | file named `SKILL.md` | `skill` |
| 19 | `type: workflow` in frontmatter | `workflow` |
| 18 | `agent` in frontmatter, or `$ARGUMENTS` in the body | `command` |
| 18 | `$1`, `$2`, or `$3` in the body, only when no ancestor directory declares a type | `command` |
| 15 | immediate parent directory declares a type | that type |
| 10 | an ancestor directory declares a type | that type |
| 8 | `model` in frontmatter, nothing stronger | `agent` |
| 5 | any other `.md` | `knowledge` |
| 3 | known script extension | `script` |

Directories that declare a type (`DIR_TYPE_MAP`) and the files they accept:

| Directory | Type | Files |
| --- | --- | --- |
| `scripts/` | `script` | script extensions |
| `skills/` | `skill` | `SKILL.md` (other files under a skill are resources, not skills) |
| `commands/`, `agents/`, `knowledge/`, `instructions/`, `memories/`, `lessons/`, `facts/`, `sessions/` | `command`, `agent`, `knowledge`, `instruction`, `memory`, `lesson`, `fact`, `session` | `.md` |
| `workflows/` | `workflow` | `.md` |
| `tasks/` | `task` | `.yml` |
| `env/` | `env` | `.env` and `*.env` |
| `secrets/` | `secret` | any file except `.lock` and `.sensitive` |

A `README.md` in a typed directory is not the directory's type; it is indexed
as `knowledge`. `$ARGUMENTS` and `agent` frontmatter beat a directory hint, so a
`knowledge/` file containing `$ARGUMENTS` is a `command`. Files under `secrets/`
are not read for frontmatter.

## The `quality` field

`quality` marks how an item was produced (`KNOWN_QUALITY_VALUES`,
`src/indexer/passes/metadata.ts`). The default is `generated`; a frontmatter
`quality` overrides it.

| Value | Meaning |
| --- | --- |
| `generated` | Derived automatically from the file; in default search |
| `curated` | Human-authored; in default search |
| `enriched` | Accepted on entries an earlier release enriched; nothing sets it now; in default search |
| `proposed` | Pending review; left out of search unless `--include-proposed` |

An unknown value warns once and stays searchable.

## Examples

| File in the bundle | Winning signal | conceptId |
| --- | --- | --- |
| `scripts/deploy.sh` | parent directory (15) | `scripts/deploy.sh` |
| `skills/review/SKILL.md` | `SKILL.md` (25) | `skills/review` |
| `commands/release.md` with `agent: coder` | frontmatter (18) | `commands/release` |
| `agents/reviewer.md` | parent directory (15) | `agents/reviewer` |
| `workflows/release.md` | parent directory (15) | `workflows/release` |
| `env/prod.env` | parent directory (15) | `env/prod` |
| `secrets/deploy-token` | parent directory (15) | `secrets/deploy-token` |
| `docs/guide.md` | fallback (5) | `knowledge/docs/guide` |
