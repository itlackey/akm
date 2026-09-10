# index-units — implementation contract, stage 1

Design: `docs/plans/index-fragment-vectors.md`. Base branch `wt/index-units`. Four modules are built
in parallel against this contract; stage 2 (the embedding loop, deletions, knob removal, migration)
starts when all four have merged. Names, signatures and DDL below are binding; internals are yours.
Rules: AGENTS.md; tests first; no new config keys; every constant named with a one-sentence reason;
`bunx biome check --write src/ tests/`, `bunx tsc --noEmit`, focused tests and `bun run lint`
before each commit; conventional commits ending "(index-units)"; trailer lines
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_01B66fKkS6fzLhAhxLQuhUxn`.

## A1 — `src/indexer/units/unit.ts` (units from what the index already has)

```ts
export interface EmbeddingUnit {
  entryId: number;
  /** 0 is the structured-fields unit every entry has; fragment units follow in fragment order. */
  ordinal: number;
  /** MarkdownFragment.fragmentId for a fragment unit (sub-units share it); null for ordinal 0. */
  fragmentId: string | null;
  /** hashEmbeddableText(text) — sha256 hex of exactly the text sent to the provider. */
  hash: string;
  /** Header line, "\n", body. Header = entry name, then " › " + section title for a fragment. */
  text: string;
}
export interface UnitSource {
  entryId: number;
  name: string; description: string; tags: string; hints: string;   // buildSearchFields(entry)
  /** entry_fragments.safe_markdown, or null for an entry without markdown content. */
  safeMarkdown: string | null;
}
/** maxChars bounds every unit's text; a fragment over it is split at the last "\n" (else the last
 *  space) before the bound into sub-units that keep the fragmentId and take the next ordinals. */
export function deriveUnits(source: UnitSource, maxChars: number): EmbeddingUnit[];
```
Unit 0 text: header line (the name) + "\n" + description, tags, hints (the non-empty ones, one per
line). Fragment units: `splitMarkdownFragments(safeMarkdown)` in order; section title = the
fragment's first heading line if it starts with one, else the nearest preceding heading in
`safeMarkdown` (track it while iterating), else none. Reuse `hashEmbeddableText` from
`embedding-salvage-repository.ts` (move it to `src/core/hash.ts` if you prefer; keep one function).
Tests: a plain note (one unit), a long markdown doc (ordinals, fragmentIds, headers), a fragment
over `maxChars` (split at a newline, same fragmentId, hashes differ), determinism (same input →
same hashes), unicode safety.

## A2 — `src/storage/repositories/units-repository.ts` (the durable store)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS units_vec USING vec0(
  unit_id   INTEGER PRIMARY KEY,
  embedding FLOAT[<dim>],
  +unit_hash TEXT,
  +identity  TEXT
);                                    -- the ONE copy of every vector (aux columns verified on 0.1.9)
CREATE TABLE IF NOT EXISTS units (    -- lookup index; vec0 aux columns are not indexable
  unit_id   INTEGER PRIMARY KEY,
  unit_hash TEXT NOT NULL,
  identity  TEXT NOT NULL,
  UNIQUE (unit_hash, identity)
);
CREATE TABLE IF NOT EXISTS entry_units (   -- derived mapping; rebuilt with the index, cheap
  entry_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  fragment_id TEXT,
  unit_hash   TEXT NOT NULL,
  PRIMARY KEY (entry_id, ordinal)
);
CREATE INDEX IF NOT EXISTS entry_units_hash ON entry_units(unit_hash);
```
Lifecycle rule (the whole design): `units` and `units_vec` are created if missing and NEVER
dropped by `rebuildIncompatibleIndexGeneration`, by `akm index --full`, or by any purge; only
`dropOtherIdentities` below removes rows. One active identity per index.db; `identity` is the
observed `remote:<model>|<dim>` / `local:<model>|<dim>` string (`deriveObservedEmbeddingIdentity`).
```ts
export function ensureUnitTables(db: Database, dim: number): void;      // idempotent; dim from the identity
export function upsertUnitVectors(db, rows: { hash: string; identity: string; vector: EmbeddingVector }[]): { inserted: number };
export function listMissingHashes(db, hashes: readonly string[], identity: string): string[]; // chunk IN by SQLITE_CHUNK_SIZE
export function replaceEntryUnits(db, entryId: number, units: readonly { ordinal: number; fragmentId: string | null; hash: string }[]): void;
export function deleteEntryUnits(db, entryIds: readonly number[]): void;
export function searchUnits(db, query: EmbeddingVector, k: number, identity: string): { unitId: number; hash: string; distance: number }[];
export function groupUnitHitsByEntry(db, hits): Map<number, { distance: number; fragmentId: string | null; hash: string }>; // best (lowest distance) unit per entry via entry_units
export function dropOtherIdentities(db, keep: string, dim: number): { removed: number }; // recreate units_vec when the width differs
export function unitCoverage(db, identity: string): { entries: number; entriesFullyCovered: number; unitsTotal: number; unitsPresent: number };
```
Wire `ensureUnitTables` into `index-schema.ts`'s ensure path (dim = `embeddingDim` meta when known,
else `EMBEDDING_DIM`) and prove with tests that `rebuildIncompatibleIndexGeneration` and the
`--full` drop path leave `units`/`units_vec` intact (the tests may call the schema functions directly
on a temp db). Also: a JS fallback is NOT required — if sqlite-vec is unavailable, `searchUnits`
throws a clear `AkmError` and the caller falls back to lexical search.

## A3 — `src/llm/embedders/provider-limits.ts` (the provider's limits, not ours)

```ts
export interface ProviderLimits {
  windowTokens: number;                       // real tokens one request may carry
  slots: number;                              // requests the server can hold in flight
  source: "llama.cpp" | "ollama" | "default";
  countTokens?: (text: string) => Promise<number>;   // exact, when the provider has /tokenize
  charsPerToken: number;                      // calibrated p99-safe ratio when countTokens is absent
}
export async function probeProviderLimits(config: EmbeddingConnectionConfig, opts?: { signal?: AbortSignal; fetch?: typeof fetch }): Promise<ProviderLimits>;
export function unitMaxChars(limits: ProviderLimits): number;   // floor((windowTokens − UNIT_HEADER_MARGIN_TOKENS) × charsPerToken)
```
llama.cpp: `GET <base>/props` → `default_generation_settings.n_ctx`, `total_slots`; `/tokenize`
present → `countTokens`. Ollama: `POST /api/show {model}` → `model_info["<arch>.context_length"]`,
slots 1 (`num_parallel` is not exposed). Anything else (OpenAI-compatible, gateways): `source:
"default"`, `DEFAULT_WINDOW_TOKENS = 8192` (named, with the reason: the most common embedding window;
the same-run shrink corrects an overestimate), slots 1. `charsPerToken`: when `countTokens` exists,
calibrate on the first 64 unit texts and use the 1st-percentile ratio (the densest text); otherwise
`CHARS_PER_TOKEN_TAIL = 2.6` (field-measured p99 on dense markdown, #954). `config.concurrency`
and `config.timeoutMs`, when set, override `slots` / the timeout. Probes are bounded by the
existing 3 s health probe timeout constant (reuse it) and never throw: a failed probe is
`source: "default"`. Tests with `withMockedFetch`: each provider shape, a failed probe, the
calibration, `unitMaxChars`. Do not remove any config key in this stage.

## A4 — search over units (`index-vec-repository.ts`, `src/indexer/search/*`)

```ts
export function searchEntriesViaUnits(db, query: EmbeddingVector, k: number, identity: string): Map<number, { score: number; fragmentId: string | null }>;
```
`k` for the unit KNN = requested entries × the mean units per entry (from `entry_units`, min 1);
score transform identical to today's `entries_vec` path so the fusion weights keep their meaning.
The semantic branch of search uses units when `units` has rows for the active identity
(`getMeta(db, "embeddingIdentity")`), otherwise today's `entries_vec` path (the bridge during the
first pass). Carry `matchedFragmentId` through `RankedEntryInput` into the search result envelope
(optional field; absent when the match came from unit 0 or from `entries_vec`). Fusion weights and
`minScore` untouched. Tests: grouping picks the best unit per entry; bridge fallback; the envelope
field; existing search tests unchanged.
