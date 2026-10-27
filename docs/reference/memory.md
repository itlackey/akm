# Memory

Reference for the `memory` asset type: capture, belief states, and derived
memories.

## Contract

Memories are context fragments — observations, decisions, snippets —
captured as markdown files. Capture one directly in your working bundle with
`akm remember "..."`, or point akm at any directory of memory files written
by another tool:

```sh
# File-based memory store from another tool
akm bundle add ~/my-agent/memories
```

Memory assets appear in search results with the `memory` type, giving agents
access to recalled context from previous sessions.

## Schema

Memories captured with `akm remember` can carry optional YAML frontmatter
that the indexer records:

| Field | Purpose |
| --- | --- |
| `tags` | Free-form categorization |
| `source` | Where the memory came from (also used as the derived-memory parent backref — see below) |
| `observed` | When the observation happened. Older memories may carry `observed_at`; it is still read, and `observed` wins when both are present. `akm` writes only `observed`. |
| `expires` | When the memory should stop being considered current |
| `subjective` | Marks the memory as opinion/preference rather than fact |
| `description` | Short human-readable summary |
| `captureMode` | `hot` (written via `akm remember`) or `background` (inferred by `akm improve`) |
| `beliefState` | See belief states below |
| `supersededBy` | Points at the memory that replaced this one |

Supply frontmatter fields explicitly with `--tag`/`--expires`/`--source`,
derive them from the body heuristically with `--auto`, or have the
configured LLM propose them with `--enrich`. See
[`akm remember`](cli.md#remember) for the full flag list.

### Belief states

Memories carry a `beliefState` field that records how current they are.
Search ranking does not read it; the `--belief` filter below does. The
supported values, from strongest to weakest authority:

| State | When it's set | `--belief` |
| --- | --- | --- |
| `asserted` | Written directly by `akm remember` (user-explicit) | current |
| `active` | Default for memories with no explicit state | current |
| `deprecated` | Marked as no-longer-current but not yet superseded; frozen (never auto-refreshed) | historical |
| `superseded` | Replaced by another memory via the `supersededBy` field | historical |
| `contradicted` | Marked as contradicted by other evidence | historical |
| `archived` | Soft-deleted; retained for audit | historical |

`akm search` and `akm curate` filter via `--belief current|historical|all`:

- `current` (default) → `active` + `asserted`; an asset with no `beliefState`
  counts as `active`, so ordinary skills, knowledge and notes still surface
- `historical` → `deprecated` + `superseded` + `contradicted` + `archived`
- `all` → no filter: every belief state, including `archived` and
  `contradicted`, is eligible to surface.

### Derived memories as retrieval shortcuts

When `akm improve` infers a derived memory from a parent (e.g. distilling a
verbose memory into a focused summary), the derived memory is written with a
`source:` frontmatter backref naming the parent, and the indexer records the
parent/child link in the `derived_from` column. This provenance backref is a
sanctioned internal channel that carries a bare parent name, not a public
[ref](refs.md) — agents never construct it.

Inference receives the body with selected existing source context: title,
description, evidence and references, known source dates, and normalized scope.
The request carries that context as JSON after a `Source context:` line, then
the raw body after a `Body:` line, as written and not JSON-escaped. Everything
after the first `Body:` line is treated as the body, so a body cannot pose as
context. A memory with an empty body is not sent. The prompt asks the model to preserve qualifications, uncertainty, actors, and the distinction between
requests, references, attempts, and demonstrated outcomes. The caller copies
the parent's normalized user/agent/run/channel scope to the child; the model
cannot author that scope. Source evidence remains on the parent via the backref.
Existing children are kept and never regenerated. On each inference run, an
existing child (`<parent>.derived.md` with `inferred: true` and `derivedFrom`
naming its parent) whose scope differs from its parent's has only its scope
frontmatter rewritten to match. This covers children written before scope was
copied and later parent scope edits, so the child stays reachable under the
parent's scope filter. The flat `scope_*` keys are set; stale ones and a legacy
nested `scope:` are removed. The body and other metadata are kept byte for
byte. No model call is made, a matching child is not written, and a read-only
default bundle is skipped. The run reports the count as `scopeSynced`. A cached no-change decision is reconsidered when
the body or supplied source context changes; unrelated metadata does not
invalidate it.

Search hits for the parent memory preserve a meaningful authored description
and tags that add information beyond filename and directory tokens. The derived
child's metadata fills missing or whitespace-only fields independently; a known
filename-generated description or tags consisting only of generated path tokens
also permit fallback. An authored tag repeating a path token counts as generated.
An `expandTo: memories/<derived>` field on the hit points at the richer
derived ref, qualified with the parent's bundle when needed. The parent ref
itself is preserved on the hit, so existing
automation keeps working — agents that want the deeper summary follow
`expandTo`.

## Defaults

- Hot-path memories (those written via `akm remember`) receive
  `captureMode: hot` and `beliefState: asserted` in their frontmatter
  automatically.
- Background-derived memories (those inferred from other assets by `akm
  improve`) receive `captureMode: background`.
- A memory with no explicit `beliefState` defaults to `active`.
- `akm search --belief` and `akm curate --belief` default to `current`; pass
  `--belief all` (API `belief: "all"`) for every belief state.

## Storage

- Memories are plain markdown files inside a bundle directory; there is no
  separate memory store. `akm improve` and `akm lint` only operate on
  writable sources — a read-only registry-cached memory source is excluded
  from cleanup and derivation passes even if it's indexed.
- The derived-memory `source:` backref and the index's `derived_from` column
  are an internal provenance channel, not a ref an agent should read,
  construct, or rely on programmatically. Use the `expandTo` field on a
  search hit instead.
- Belief-state frontmatter is rewritten in place by `akm improve`'s memory
  cleanup lane when autonomy is enabled (`experimental.improveAutonomy`);
  with autonomy off, cleanup is analyzed but not applied. See
  `STABILITY.md`'s "`akm improve` autonomy" section.

## Stability

Per `STABILITY.md`, **memory belief-state transitions are Experimental**:
`captureMode`, `beliefState`, contradiction edges, and the consolidate
journal are observable but the algorithm that writes them is tuning across
patch releases. Do not script against the exact transition logic — the
frontmatter fields and their meanings above are the stable-enough surface to
read, but when and how akm assigns them is still settling. The `lesson`
asset type, which shares the same distillation pipeline, is also
Experimental for the same reason.

## See also

- [Concepts](../guides/concepts.md) — how a memory fits the capability model
- [Refs](refs.md) — the public ref grammar (distinct from the internal derived-memory backref)
- [Asset Types](asset-types.md) — where `memory` sits in the full type taxonomy
- [`akm remember`](cli.md#remember) — the capture command and its flags
- `STABILITY.md` — the full stability tier index, including `akm improve` autonomy
