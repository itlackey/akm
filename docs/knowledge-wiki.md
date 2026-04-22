# Knowledge Wiki

The akm knowledge wiki implements Andrej Karpathy's LLM Wiki pattern on top of
the built-in `knowledge` asset type. There is no separate wiki provider — it is
a set of conventions inside `knowledge/` in your working stash, driven by the
LLM-powered `akm import --llm` and `akm lint` commands.

## Prerequisites

The wiki requires an LLM to be configured. Run `akm setup` (recommended) or
set it manually:

```sh
akm config set llm '{"endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2"}'
```

Full LLM config fields:

| Field | Type | Description |
| --- | --- | --- |
| `endpoint` | string | OpenAI-compatible chat completions URL |
| `model` | string | Model name (e.g. `llama3.2`, `gpt-4o`) |
| `temperature` | number | Sampling temperature (default: model default) |
| `maxTokens` | number | Max tokens per response |
| `apiKey` | string | API key (prefer `AKM_LLM_API_KEY` env var) |
| `contextWindow` | number | Approximate context window in tokens; used to size ingest/lint chunks |
| `provider` | string | Display label only (e.g. `"ollama"`, `"openai"`) |

## Bootstrapping the Wiki

The first time you run `akm import --llm` or `akm lint`, akm automatically
scaffolds the wiki if it does not already exist (idempotent). The scaffold
creates:

```
<stashDir>/
  knowledge/
    schema.md       # Rulebook for the wiki
    index.md        # Page catalog by category
    log.md          # Append-only operation log
    raw/            # Immutable ingested sources
  skills/
    knowledge-ingest/SKILL.md
    knowledge-query/SKILL.md
    knowledge-lint/SKILL.md
```

Files that already exist are left untouched — bootstrapping is safe to run
repeatedly.

## Wiki Configuration Options

The only dedicated wiki setting in `config.json` is `knowledge.pageKinds`.

### `knowledge.pageKinds`

**Type:** `string[]`  
**Default:** `[]` (only the four built-in kinds are used)

Declares additional page kinds beyond the four built-ins (`entity`, `concept`,
`question`, `note`). Kinds listed here are:

- Offered to the LLM as first-class categories during `akm import --llm`
- Added as named sections in the scaffolded `index.md`
- Accepted in frontmatter at any time regardless of config (any non-empty
  string is valid as a `pageKind`)

Any `pageKind` already present across your existing pages is also fed to the
LLM automatically, so ad-hoc kinds stay consistent across ingests without
being declared in config.

Set it via the CLI:

```sh
akm config set knowledge '{"pageKinds":["decision-record","glossary"]}'
```

Or edit `~/.config/akm/config.json` directly:

```json
{
  "knowledge": {
    "pageKinds": ["decision-record", "glossary"]
  }
}
```

## Page Frontmatter Reference

Every wiki page is a `.md` file under `knowledge/`. Frontmatter fields used by
the wiki:

| Field | Type | Description |
| --- | --- | --- |
| `description` | string | One-sentence summary shown in search results and lint |
| `pageKind` | string | Category: `entity`, `concept`, `question`, `note`, or any custom kind |
| `xrefs` | `string[]` | Cross-references to other pages, e.g. `knowledge:other-page` |
| `sources` | `string[]` | Raw source files this page was derived from, e.g. `raw/the-source.md` |
| `wikiRole` | string | Reserved for special files (`schema`, `index`, `log`, `raw`) — do not use on ordinary pages |

Example page:

```yaml
---
description: "OAuth 2.0 authorization code flow used by the API gateway."
pageKind: concept
xrefs:
  - knowledge:api-gateway
  - knowledge:jwt-tokens
sources:
  - raw/oauth-notes.md
---

# OAuth 2.0 Auth Code Flow

...
```

## Wiki Operations

### Ingest

Copies a source into `raw/`, asks the LLM to plan updates, then writes or
amends pages and logs the change.

```sh
akm import ./notes/auth-flow.md --llm             # Apply immediately
akm import ./notes/auth-flow.md --llm --dry-run   # Preview plan, don't write pages
akm import - --llm --name q-oauth < prompt.md     # Ingest from stdin
```

### Query

No special command — use search and show:

```sh
akm search "oauth token refresh"
akm show knowledge:oauth-auth-code-flow
akm show knowledge:oauth-auth-code-flow toc
akm show knowledge:oauth-auth-code-flow section "Token Refresh"
```

### Lint

Audits the wiki for contradictions, orphaned pages, stale claims, and missing
cross-references:

```sh
akm lint               # Report only
akm lint --fix         # Apply low-risk fixes (missing-xref additions)
```

## Configuration Examples by Use Case

### Minimal: personal notes (defaults only)

No `knowledge` section needed. The four built-in kinds (`entity`, `concept`,
`question`, `note`) cover most personal knowledge capture.

```json
{
  "llm": {
    "endpoint": "http://localhost:11434/v1/chat/completions",
    "model": "llama3.2"
  }
}
```

### Engineering team: architecture records and retrospectives

Add `decision-record` and `retrospective` so the LLM classifies ADRs and
retros correctly and `index.md` gets dedicated sections.

```json
{
  "llm": {
    "endpoint": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-4o",
    "maxTokens": 2048
  },
  "knowledge": {
    "pageKinds": ["decision-record", "retrospective"]
  }
}
```

Usage:

```sh
akm import ./docs/adr-001-auth-strategy.md --llm
akm import ./retrospectives/q1-2026.md --llm
```

### Research team: papers and glossary terms

Add `paper`, `glossary`, and `experiment` so research papers and terminology
are filed separately from general notes.

```json
{
  "llm": {
    "endpoint": "https://api.anthropic.com/v1/messages",
    "model": "claude-3-5-sonnet-latest",
    "contextWindow": 100000
  },
  "knowledge": {
    "pageKinds": ["paper", "glossary", "experiment"]
  }
}
```

Usage:

```sh
akm import ./papers/attention-is-all-you-need.md --llm
akm import - --llm --name "q-transformer-vs-rnn" <<< "What is the difference between transformers and RNNs?"
```

### Project `.akm/config.json`: project-scoped wiki kinds

Place a config file in the project root to add project-specific kinds without
touching your global config. Project configs are merged on top of the user
config.

```json
{
  "knowledge": {
    "pageKinds": ["api-contract", "runbook", "incident"]
  }
}
```

All wiki operations run from inside this project will include these kinds
automatically. Global config kinds remain active as well.

## Summary of Wiki-Relevant Config Keys

| Key | Scope | What it does |
| --- | --- | --- |
| `llm` | global or project | Required. Drives ingest and lint |
| `llm.contextWindow` | global or project | Sizes ingest/lint chunks for large models |
| `knowledge.pageKinds` | global or project | Registers custom page categories |

Everything else — the `raw/` directory, `schema.md`, `index.md`, `log.md`,
and page frontmatter — is convention, not configuration, managed automatically
by `akm import --llm` and `akm lint`.
