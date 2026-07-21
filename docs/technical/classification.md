# Classification System

akm recognizes files through **bundle adapters**. Each adapter owns a bundle
format and exposes a `recognize()` primitive that inspects a single file (path +
frontmatter + content) and returns an `IndexDocument` — the item's
subdir-qualified `conceptId`, type, renderer, and metadata — or `null` if the
adapter does not claim the file. There is no longer a global matcher registry;
the per-format adapter is the unit of recognition.

## Built-in adapters

The registry is a **static frozen list** (`BUILTIN_ADAPTERS` in
`src/core/adapter/adapters/index.ts`, exposed through
`src/core/adapter/registry.ts`) — always populated at module load, no
registration call required. Eleven built-ins, in probe order:

| Adapter id | Format | Recognizes |
| --- | --- | --- |
| `website-snapshot` | Crawled website snapshot bundle (read-only) | snapshot pages |
| `agent-skills` | Agent-skills package (root `SKILL.md`) | skills |
| `claude` | A `.claude/` tool directory | commands, agents, skills, settings-adjacent files |
| `opencode` | An `.opencode/` tool directory | commands, agents, skills |
| `dotenv` | Env-file bundle | env/secret whole-file assets (values never indexed) |
| `akm-workflow` | Workflow-dir component | workflow programs |
| `akm-task` | Task-dir component | scheduled task definitions |
| `llm-wiki` | LLM Wiki bundle | a wiki root (`schema.md` + `pages/`) and its pages, raw, xrefs, citations |
| `okf` | Open Knowledge Format bundle | OKF concept documents |
| `akm` | The classic AKM stash layout | scripts, skills, commands, agents, knowledge, workflows, memories, lessons, env, secrets, facts, tasks, sessions |
| `generic-files` | Catch-all file mount | explicit configuration only — never auto-probed |

`looksLikeRoot` probes run most-specific-first in the list order above; the
first match wins and the winner is recorded per component. A root matching no
probe falls back to `akm` (a recorded deviation from spec §1.2(3)'s `okf`
fallback — see `FALLBACK_ADAPTER_ID` in `src/indexer/installations.ts`).
`generic-files` never participates in probing.

## Item types

The `akm` adapter classifies each file into one of the open type set. Types are
open strings (validated against `KNOWN_TYPES` for AKM-owned presentation/ranking
tables, but the data space accepts unknown types with a warn-once fallback):

- `script`
- `skill`
- `command`
- `agent`
- `knowledge`
- `workflow`
- `memory`
- `lesson`
- `env`
- `secret`
- `fact`
- `task`
- `session`

`wiki` is **no longer an item type**. Multi-page wikis are a bundle *format* owned
by the `llm-wiki` adapter, not a per-file type stamped by the classifier.

## Reserved structural files

`index.md` and `log.md` are reserved structural files at every level of a bundle
(OKF §3.1/§6/§7). No adapter emits an `IndexDocument` for them — they are bundle
structure (directory listing, update history), never concept items. This holds for
the `akm`, `okf`, and `llm-wiki` adapters alike.

## The akm adapter's recognition signals

Inside the `akm` adapter, recognition picks a winner by **specificity descending**,
ties broken by registration order (later wins). The signals:

| Specificity | Signal | Result |
| --- | --- | --- |
| 25 | `SKILL.md` (skill directory) | `skill` |
| 20 | `tools` / `toolPolicy` frontmatter | `agent` |
| 19 | workflow markdown structure | `workflow` |
| 18 | command frontmatter / `$ARGUMENTS` body placeholders | `command` |
| 15 | immediate parent dir hint | directory-specific type |
| 10 | ancestor dir hint | directory-specific type |
| 8 | `model` frontmatter only | weak `agent` signal |
| 5 | fallback markdown | `knowledge` |
| 3 | known script extension | `script` |

### Directory signals

- `scripts/` → `script`
- `skills/` → `skill`
- `commands/` → `command`
- `agents/` → `agent`
- `knowledge/` → `knowledge`
- `workflows/` → `workflow`
- `memories/` → `memory`
- `lessons/` → `lesson`
- `env/` → `env`
- `secrets/` → `secret`
- `tasks/` → `task`

### Markdown signals

| Signal | Type | Specificity |
| --- | --- | --- |
| `tools` or `toolPolicy` in frontmatter | `agent` | 20 |
| workflow heading/step structure | `workflow` | 19 |
| `agent` in frontmatter | `command` | 18 |
| `$ARGUMENTS` or `$1`-`$3` in body | `command` | 18 |
| `model` in frontmatter only | `agent` | 8 |
| any other `.md` | `knowledge` | 5 |

## Asset quality values

The `quality` field marks how an item was produced. Four values are well-known:

| Value | Meaning |
| --- | --- |
| `"generated"` | Heuristically indexed; included in default search |
| `"curated"` | Human-authored; included in default search |
| `"enriched"` | LLM enrichment pass has run for this item; included in default search |
| `"proposed"` | Pending review; excluded from default search, opt-in via `--include-proposed` |

Unknown string values warn once at runtime and remain searchable.

## Examples

| File | Winning signal | conceptId |
| --- | --- | --- |
| `scripts/deploy.sh` | parent dir (15) → `script` | `scripts/deploy.sh` |
| `skills/review/SKILL.md` | `SKILL.md` (25) → `skill` | `skills/review` |
| `commands/release.md` with `agent: coder` | command frontmatter (18) | `commands/release` |
| `agents/reviewer.md` with `tools:` | frontmatter (20) → `agent` | `agents/reviewer` |
| `workflows/release.md` with workflow structure | structure (19) → `workflow` | `workflows/release` |
| `env/prod.env` | parent dir (15) → `env` | `env/prod` |
| `secrets/deploy-token` | parent dir (15) → `secret` | `secrets/deploy-token` |
| `docs/guide.md` | fallback (5) → `knowledge` | `knowledge/guide` |
