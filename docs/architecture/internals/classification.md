# Classification

akm recognizes files through **bundle adapters**. An adapter owns one bundle
format. Whether a file is an asset, and which one, is a pure function of its
path: the adapter's `identify(relPath)` gives the `conceptId` (or says the file
is no asset) and gets no bundle, no file system and no content, so listing or
finding an asset never reads a file. Its `recognize()` method then describes one
file for the index: it returns an `IndexDocument` (the `conceptId` from the
path, plus the type, renderer, and metadata, which may come from the content) or
`null`. The type is index metadata: every read of a type goes to the index, not
to the file. The indexer calls `recognize()` for every file the walker finds
(see [Indexing](indexing.md)).

## Built-in adapters

`BUILTIN_ADAPTERS` in `src/core/adapter/adapters/index.ts` is a frozen list,
exposed through `src/core/adapter/registry.ts`. Its order is the install-time
probe order, and it is the one list of adapter ids: adding an adapter is one
class file and one line in it. The registry (`requireAdapter`) rejects an id that is not in the
list where a bundle names one, and `akm config set` and `akm doctor` check it up front. There are eleven:

| Adapter id | Format | Recognizes |
| --- | --- | --- |
| `website-snapshot` | Crawled website snapshot (read-only) | every `.md` page under `stash/knowledge/`, typed `website` |
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
winner is recorded per bundle. A root matching no probe falls back to `akm`
(`FALLBACK_ADAPTER_ID`, `src/indexer/installations.ts`). `generic-files` is not
probed. An adapter set in a bundle's config entry (`bundles.<name>.adapter`,
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

The `akm`, `okf`, `claude`, `opencode` and `generic-files` adapters reserve
`index.md` and `log.md` at every depth, and neither is an item (`RESERVED_FILES`,
`src/core/adapter/adapters/shared.ts`). `llm-wiki` reserves `schema.md`,
`index.md` and `log.md` only at the wiki root. The `akm` adapter also
skips, by path alone (`akmStashAbstains`,
`src/core/adapter/adapters/akm-adapter.ts`):

- the bundle's root `README.md`;
- a `secrets/` file that is a `.sensitive` or `.lock` sidecar (`.sensitive` is a retired marker, ignored).

A `wikis/` folder inside an `akm` bundle gets no special handling: a wiki is
always a bundle of its own (adapter `llm-wiki`), and the files of such a folder
are ordinary akm files.

The walker itself skips VCS internals. It indexes a symlink to a file like any other file and never descends a symlinked directory.

## How the akm adapter picks a type

The `akm` adapter types a file from its path alone, with four matchers from
`src/indexer/walk/matchers.ts` (`extensionMatcher`, `directoryMatcher`,
`parentDirHintMatcher`, `looseMarkdownMatcher`) that never see the file's
content. `recognizeMatch` (`src/core/adapter/recognize-match.ts`) collects their
results and picks the highest specificity. On a tie the matcher registered later
wins, in the order listed.

| Specificity | Signal | Type |
| --- | --- | --- |
| 25 | file named `SKILL.md` | `skill` |
| 15 | immediate parent directory declares a type | that type |
| 10 | an ancestor directory declares a type | that type |
| 5 | any other `.md` | `knowledge` |
| 3 | known script extension | `script` |

Directories that declare a type (`DIR_TYPE_MAP`) and the files they accept:

| Directory | Type | Files |
| --- | --- | --- |
| `scripts/` | `script` | script extensions |
| `skills/` | `skill` | `SKILL.md` (other files under a skill are resources, not skills) |
| `commands/`, `agents/`, `knowledge/`, `instructions/`, `rules/`, `memories/`, `lessons/`, `facts/`, `sessions/` | `command`, `agent`, `knowledge`, `instruction`, `rule`, `memory`, `lesson`, `fact`, `session` | `.md` |
| `workflows/` | `workflow` | `.md` (a `.yml` is typed `workflow`, then skipped at index time with a warning that it must use `.md`) |
| `tasks/` | `task` | `.yml` |
| `env/` | `env` | `.env` and `*.env` |
| `secrets/` | `secret` | any file except `.lock` and `.sensitive` |

A `README.md` in a typed directory is not the directory's type; it is indexed
as `knowledge`. A `.md` file directly in `skills/` names no skill; it is `knowledge`.
Frontmatter and body never change a type: a command belongs under `commands/`,
an agent under `agents/`, a workflow under `workflows/`. Earlier releases read
`type: workflow`, `agent`, `model` and `$ARGUMENTS`/`$1`..`$3` placeholders as
type signals; `akm lint` now reports `type-from-content` for a file whose
content suggests another type than its path gives, and names the folder to move
it to.

When one concept is spelled by more than one file (`skills/x.md` and
`skills/x/SKILL.md`, or `tasks/x.yml` and `tasks/x.md`), the first spelling in
the adapter's order is the asset for every reader, and `akm lint` reports the
ignored files as `shadowed-spelling`.

Classification changes bump the AKM adapter version, which participates in
directory freshness. The next ordinary `akm index` reclassifies unchanged
documents and replaces stale refs; no full reset or source-file edit is needed.

For the `akm doctor` type-directory advisory, `SKILL.md` under the component's
`skills/` tree declares a skill, even when the skill directory is named
`knowledge`, `memories`, or `commands`. Those names identify the skill, not a
competing asset type. A copied `knowledge/.../SKILL.md` does not have that
skills-directory intent and is still checked against its knowledge directory.

## The `quality` field

`quality` marks how an item was produced (`KNOWN_QUALITY_VALUES`,
`src/indexer/passes/metadata.ts`). The default is `generated`; a frontmatter
`quality` overrides it.

| Value | Meaning |
| --- | --- |
| `generated` | Derived automatically from the file; in default search |
| `curated` | Human-authored; in default search |
| `enriched` | Accepted on entries an earlier release enriched; nothing sets it now; in default search |
| `proposed` | Pending review; left out of search unless `--include quality=proposed` |

An unknown value warns once and stays searchable.

## Examples

| File in the bundle | Winning signal | conceptId |
| --- | --- | --- |
| `scripts/deploy.sh` | parent directory (15) | `scripts/deploy.sh` |
| `skills/review/SKILL.md` | `SKILL.md` (25) | `skills/review` |
| `commands/release.md` with `agent: coder` | parent directory (15) | `commands/release` |
| `agents/reviewer.md` | parent directory (15) | `agents/reviewer` |
| `workflows/release.md` | parent directory (15) | `workflows/release` |
| `env/prod.env` | parent directory (15) | `env/prod` |
| `secrets/deploy-token` | parent directory (15) | `secrets/deploy-token` |
| `docs/guide.md` | fallback (5) | `knowledge/docs/guide` |
