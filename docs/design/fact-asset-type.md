# Design: the `fact` asset type — durable stash-level knowledge

Status: accepted (phase 1 implemented)
Author: akm
Date: 2026-06-20

## Problem

akm has no home for **durable, mostly-static facts about a user, team, or
project**. Concretely, users want a stash to carry things like:

- **Personal** — name, email, address, timezone, favorite blogs, writing/working style.
- **Team** — tool stacks, primary languages, CI/CD platform, deployment targets, web addresses.
- **Conventions / constitution** — coding conventions, architecture principles, lint rules.
- **Stash meta** — folder organization, naming conventions, expected frontmatter, the active-projects list.

Today these have nowhere first-class to live:

- `memory` is **episodic** — recency-decayed, belief-state ranked, captured ad-hoc via `akm remember`. It models "what I observed in a session," not "what is durably true about this stash."
- `knowledge` is curated **reference material** — documents an agent reads on demand, not stash-level identity/conventions injected as context.
- `lesson` is a **`when_to_use` trigger** distilled from feedback.
- The `.meta/` convention (`src/core/asset/stash-meta.ts`, `docs/concepts.md` "Stash orientation") is **documentary only**: not indexed, not searchable, not ranked, and not surfaced to agents automatically.

## Conceptual grounding

The agent-memory literature splits long-term memory three ways (CoALA,
*Cognitive Architectures for Language Agents*, arXiv:2309.02427; echoed by
LangMem and Letta/MemGPT). akm already covers two of the three:

| Memory class | "answers" | akm |
| --- | --- | --- |
| **Episodic** — timestamped events | "what happened" | `session` (#561) |
| **Procedural** — executable how-to | "how to do X" | `skill`, `command`, `workflow` |
| **Semantic** — durable facts/identity | "what is true" | **`fact` (this doc)** |

Karpathy's operating-system analogy frames the design: model weights are the
CPU/ROM (can't retrain), the context window is scarce RAM, and everything else
is disk that must be *paged in*. A fact is **disk-resident knowledge selectively
loaded into RAM** — neither baked into weights nor permanently pinned in the
system prompt. Anthropic's *Effective context engineering for AI agents*
reinforces this: curate aggressively, prefer just-in-time retrieval, and pin
only a small high-signal core (cf. CLAUDE.md, kept short).

## Design

### Type: `fact`

A first-class, indexed, searchable markdown asset type. Stored under
`facts/` in a stash; ref form `fact:<name>` (nesting allowed, e.g.
`fact:team/tool-stack`). Singular name matches akm convention
(`skill`, `memory`, `lesson`, `task`, `session`).

```
<stash>/facts/
  personal/identity.md         # fact:personal/identity
  personal/writing-style.md
  team/tool-stack.md
  conventions/coding.md         # the "constitution"
  meta/naming-conventions.md
  meta/active-projects.md
```

### One type, categorized — not a type explosion

Rather than separate `fact` / `constitution` / `profile` types, a single
`fact` type carries a `category` frontmatter dimension. This keeps akm's
minimalist type set and matches the LangMem "namespace/scope" approach.
Recommended values: `personal`, `team`, `project`, `convention`, `meta`.
Normative facts (the "constitution") are stored as facts and phrased as
guidance at injection time.

### Frontmatter

```yaml
---
description: <one-line, indexed for search>   # like other markdown types
category: personal|team|project|convention|meta
pinned: false        # true → part of the always-injected core (keep this set small)
updated: 2026-06-20
---
```

`description` and `category` are the curation surface; `pinned` selects the
small always-on core. Additional keys (`source`, `status`, …) are accepted
but not required in phase 1.

### Retrieval & injection model: pinned core + JIT retrieval

Two tiers, matching the context-engineering guidance:

1. **`pinned: true` facts** form the small always-injected core (CLAUDE.md
   style — keep it short). Phase 1 makes `pinned` a real, captured, query-
   surfaceable property (tag + search hint + ranking boost); **phase 2** wires
   the assembled pinned-core into harness system prompts.
2. **Everything else** stays on "disk" and is surfaced through normal
   `akm search` / `akm curate` / `akm show` (JIT retrieval). This works the
   day the type ships — no new retrieval path required.

### Ranking

`fact` gets a high `TYPE_BOOST` (authoritative, like `knowledge`), plus a
modest additional boost for `pinned` facts so the core outranks ordinary
facts on otherwise-equal queries.

## Implementation (phase 1)

Following the `session`/`task` template, metadata is encoded as tags +
search hints (no new DB columns or `StashEntry` fields):

| Concern | File |
| --- | --- |
| Type spec | `src/core/asset/asset-spec.ts` — `fact` in `ASSET_SPECS_INTERNAL` |
| Renderer + action | `src/core/asset/asset-registry.ts` — `TYPE_TO_RENDERER`, `ACTION_BUILDERS` |
| Renderer + metadata | `src/output/renderers.ts` — `factMdRenderer`, `applyFactMetadata` |
| File classification | `src/indexer/walk/matchers.ts` — `DIR_TYPE_MAP` `facts/` |
| Ranking | `src/indexer/search/ranking-contributors.ts` — `TYPE_BOOST` + pinned contributor |
| Lint | `src/commands/lint/fact-linter.ts` + `registry.ts` (warns on missing `category`) |
| Authoring hint | `src/integrations/agent/prompts.ts` — `TYPE_HINTS.fact` |
| Graph extraction (opt-in) | `src/core/config/config-schema.ts` — allow `fact` |
| Type union | derived automatically from the registry (`src/core/common.ts`) |

`fact:` refs resolve automatically — the ref resolver derives its type set
from the registry (`src/commands/lint/base-linter.ts` contract note).

## Phase 2 (implemented)

- **Pinned-core assembly + injection.** `src/commands/fact/fact-context.ts`
  collects every `fact` with `pinned: true` (via the indexed `pinned` search
  hint) and assembles a category-grouped `## Stash facts` block. The
  user-facing `akm agent` dispatch prepends this block to the system prompt
  whenever there's a task or agent asset; opt out with `--no-facts`. Collection
  fails soft (missing index / unreadable file → empty), so it can never block a
  dispatch. Internal proposal-generation agents (reflect/propose/improve) do
  **not** go through this path, so they are unaffected.
- **`akm fact` CLI** (`src/commands/fact/fact-cli.ts`):
  - `add <name> [body] --category <c> [--pinned] [--description ...]` —
    hot-capture, writing `facts/<category>/<name>.md` (à la `akm remember`).
  - `list [--category <c>] [--pinned]` — list indexed facts.
  - `context` — print the assembled pinned core (preview / pipe into AGENTS.md).
- **Staleness handling.** A fact with `status: stale` (or `superseded` /
  `archived`) is excluded from the pinned core while remaining searchable —
  authors retire a fact without deleting it.

### Phase 3 (future)

- Per-harness builder injection for non-`akm agent` entry points.
- LLM-assisted fact extraction/curation and conflict reconciliation.

## Relationship to `.meta/`

`.meta/` stays the human-oriented, non-indexed orientation convention.
`fact` is its machine-facing sibling: indexed, searchable, rankable, and
(phase 2) agent-injected.
