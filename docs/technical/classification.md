# Classification System

akm classifies files with matcher specificity. The highest-specificity match
wins; ties are broken by registration order, so later matchers win ties.

## Asset Types

Built-in types today are:

- `script`
- `skill`
- `command`
- `agent`
- `knowledge`
- `workflow`
- `memory`
- `vault`
- `wiki`

## Built-in Matchers

`src/indexer/matchers.ts` currently registers **five** built-in matchers:

1. `extensionMatcher`
2. `directoryMatcher`
3. `parentDirHintMatcher`
4. `smartMdMatcher`
5. `wikiMatcher`

## Specificity Levels

| Specificity | Signal | Result |
| --- | --- | --- |
| 25 | `SKILL.md` outside `wikis/` | `skill` |
| 20 | `tools` / `toolPolicy` frontmatter | `agent` |
| 20 | any `.md` under `wikis/<name>/...` | `wiki` |
| 19 | workflow markdown structure | `workflow` |
| 18 | command frontmatter/body placeholders | `command` |
| 15 | immediate parent dir hint | directory-specific type |
| 10 | ancestor dir hint | directory-specific type |
| 8 | `model` frontmatter only | weak `agent` signal |
| 5 | fallback markdown | `knowledge` |
| 3 | known script extension | `script` |

## Directory Signals

The directory-based matchers recognize:

- `scripts/` → `script`
- `skills/` → `skill`
- `commands/` → `command`
- `agents/` → `agent`
- `knowledge/` → `knowledge`
- `workflows/` → `workflow`
- `memories/` → `memory`
- `vaults/` → `vault`

`wiki` is not classified by these generic directory matchers. It is handled by
`wikiMatcher`, which requires a path below `wikis/<name>/...`.

## Markdown Signals

`smartMdMatcher` uses these content signals:

| Signal | Type | Specificity |
| --- | --- | --- |
| `tools` or `toolPolicy` in frontmatter | `agent` | 20 |
| workflow heading/step structure | `workflow` | 19 |
| `agent` in frontmatter | `command` | 18 |
| `$ARGUMENTS` or `$1`-`$3` in body | `command` | 18 |
| `model` in frontmatter only | `agent` | 8 |
| any other `.md` | `knowledge` | 5 |

## Wiki Override

`wikiMatcher` is registered after `smartMdMatcher`, so wiki pages win a
same-specificity tie. A wiki page with agent-like frontmatter still classifies
as `wiki`.

## Examples

| File | Winning matcher | Type |
| --- | --- | --- |
| `scripts/deploy.sh` | parentDirHint (15) | `script` |
| `skills/review/SKILL.md` | extension (25) | `skill` |
| `commands/release.md` with `agent: coder` | smartMd (18) | `command` |
| `agents/reviewer.md` with `tools:` | smartMd (20) | `agent` |
| `workflows/release.md` with workflow structure | smartMd (19) | `workflow` |
| `vaults/prod.env` | parentDirHint (15) | `vault` |
| `wikis/research/auth.md` | wikiMatcher (20) | `wiki` |
| `docs/guide.md` | smartMd (5) | `knowledge` |
