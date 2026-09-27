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
| `observed_at` | When the observation happened |
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

`akm search` filters via `--belief current|historical|all`:

- `current` → `active` + `asserted`
- `historical` → `deprecated` + `superseded` + `contradicted` + `archived`
- `all` (default — no filter) → every belief state, including `archived` and
  `contradicted` memories, is eligible to surface.

### Derived memories as retrieval shortcuts

When `akm improve` infers a derived memory from a parent (e.g. distilling a
verbose memory into a focused summary), the derived memory is written with a
`source:` frontmatter backref naming the parent, and the indexer records the
parent/child link in the `derived_from` column. This provenance backref is a
sanctioned internal channel that carries a bare parent name, not a public
[ref](refs.md) — agents never construct it.

Search hits for the parent memory are then enriched in-place: the parent's
description and tags are swapped with the derived child's surface text, and
an `expandTo: memories/<derived>` field on the hit points at the richer
derived ref. The parent ref itself is preserved on the hit, so existing
automation keeps working — agents that want the deeper summary follow
`expandTo`.

## Defaults

- Hot-path memories (those written via `akm remember`) receive
  `captureMode: hot` and `beliefState: asserted` in their frontmatter
  automatically.
- Background-derived memories (those inferred from other assets by `akm
  improve`) receive `captureMode: background`.
- A memory with no explicit `beliefState` defaults to `active`.
- `akm search --belief` defaults to `all` — no filter is applied unless you
  pass `current` or `historical` explicitly.

## Security / persistence implications

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
