# The semantic index, redesigned

## The flaw

Embeddings are derived data stored inside a cache that akm wipes: `akm index --full`
(`src/indexer/indexer.ts:1818`) and every index-generation bump
(`src/storage/repositories/index-schema.ts:212,237`) drop `entries_vec` and `embeddings` and
re-walk. Each vector is keyed by an entry id that a rebuild reassigns, produced from a text the
config shapes (the entry's search text cut at 512 estimated tokens), and governed by a fingerprint
string built from the config (`deriveSemanticProviderFingerprint`: `remote:<model>|<dimension>`)
rather than from what the provider actually returned.

Everything the owner called sloppy exists to survive that arrangement:

| Mechanism | Why it exists | Size |
| --- | --- | --- |
| `embedding_salvage` table and repository | rescue vectors before the cache is dropped, match them back by content hash afterwards | 209 lines + tests |
| the rename canary (`runEmbeddingCanary`, `decideEmbeddingCompatibility`, 8 samples, 0.999 median cosine) | the config fingerprint changes on a rename or endpoint move while the model did not; guess whether stored vectors are still valid | ~200 lines in `materialize-embeddings.ts` |
| `--reembed`, "Re-embedding N entries because …", the fingerprint purge | operator overrides for when the guess is wrong | plumbing through the same file |
| resume-after-interrupt, the ambient-transaction drift guard, per-batch commit accounting | a killed run must not restart from zero inside a cache that is rebuilt whole | ~150 lines |
| `maxInputTokens` and `capEmbeddingText`, `maxTokens` and the adaptive shrink, `batchSize`, `contextLength` | the unit is a whole entry, so its size has to be capped and packed by guesswork | four config keys, ~300 lines |

Six files, about 2,900 lines, and the three failures the field hit were all seams between them:
restart from zero on interruption, a full re-embed of identical vectors in five scopes after a
rename, and documents overflowing an 8k window under a 512-cap that did not yet exist.

## The design, in four rules

**1. The unit of embedding is the fragment.** akm already cuts every markdown body into fragments
of at most 1,600 characters and indexes each one lexically (`index-fts-repository.ts:76`,
`entry_fragments_fts`, one row per fragment). Those fragments become the embedding units, each
prefixed with one header line: the entry's name and the heading path above the fragment. An
entry without markdown content (env, session, secrets, foreign adapters) gets one unit from its
structured fields, which is the part of today's search text that comes first anyway
(`buildSearchText`: name, description, tags, hints). No cap: a unit larger than the provider's
window is split at a line boundary into ordinal sub-units. Nothing is truncated.

**2. Vectors are content-addressed and never rebuilt.** One table, `units`, keyed by
`(unit_hash, identity)`: `unit_hash` is the hash of the unit text, `identity` is what the
provider returned, model id and vector width, the same value the code already derives as
`deriveObservedEmbeddingIdentity` and stores as `embeddingIdentity`. The vec0 table that serves
search is this table, with `unit_hash` and `identity` as its auxiliary columns, so there is one
copy of every vector. The lifecycle rule is the whole design: `--full` and generation bumps
regenerate the mapping (entry → fragment → unit hash), which is cheap and derived; they never
touch `units`. Indexing is a set difference: hashes in the mapping minus hashes in `units` for
the current identity. Only that difference is sent. A killed run resumes by computing the
difference again. A rename or endpoint move that returns the same identity costs nothing. A real
model change starts a new identity, and an identity no mapping references any more is dropped.

**3. The limits are the provider's.** Window and slot count are read from the provider
(`/props` on llama.cpp, `/api/show` on Ollama); token counts are exact where the provider has
`/tokenize`, otherwise a chars-per-token ratio calibrated on a sample at first run. Requests are
packed to the window; in-flight requests equal the slots. One named constant remains for a
provider that reports nothing, 8,192 tokens, the most common embedding window, with the existing
same-run shrink as its corrective. `maxInputTokens`, `maxTokens`, `batchSize` and
`contextLength` are removed. `concurrency` and `timeoutMs` stay optional and derived when unset,
because a gateway such as Bifrost, which the field runs through, reports neither slots nor
window.

**4. Search reads fragments.** The KNN runs over `units` for the current identity and groups
hits to entries by the best fragment; the lexical side already ranks fragments. The fusion
(`0.7 × lexical + 0.3 × semantic`) is unchanged here; re-deriving those weights is a separate,
measured change. A result can name the fragment that matched, which today's index cannot.

## What this deletes

The salvage table and repository; the canary, its two thresholds and the fingerprint purge;
`--reembed` as anything but "drop this identity"; the resume special-casing and rebuild-reason
plumbing; `capEmbeddingText`, `DEFAULT_MAX_INPUT_TOKENS`, the adaptive shrink as a primary
mechanism; four config keys and their schema, docs and tests. The batching, retry, back-off,
circuit breaker and per-batch commit stay: they are the correct way to talk to a provider and
they work. Estimate: about 1,200 of the 2,900 lines go and about 400 come in.

## What it costs, plainly

- **One pass over every fragment, once per model.** On the field corpus that is roughly 21 M
  tokens: one to three hours on one slot at the two measured rates, a quarter of that on four.
  The two queries at the end give the real number. It is paid once; unchanged text is never sent
  again, and on 182 real edits to long documents in this repository 94 percent of fragments were
  unchanged after an edit.
- **Storage is float32 and about four times today's vector bytes.** 96 thousand fragments at
  the field's 1,024 dimensions is 395 MB in one copy; at 384 dimensions, 150 MB. No quantization:
  it was a patch on this growth, not part of the design, and it can be added later as an
  orthogonal switch if a bundle ever needs it.
- **A search scans every unit vector.** sqlite-vec has no approximate index. 395 MB per query at
  1,024 dimensions is on the order of 50 to 150 ms on a laptop, against about 10 ms today. If that
  matters, the lexical candidates can bound the KNN (`rowid IN (…)`) at the cost of vector-only
  recall; that is a later, measured decision, not part of this design.
- **Ranking risk.** A long document has many fragments and therefore many chances to score
  high. Grouping by best fragment is the simplest rule; the existing `curate-golden` fixture
  decides whether the mean of the top two is needed.
- **About ten days** for one engineer: the table and identity rule, units and headers and the
  real-token split, the diff-driven loop on the existing batching code, search grouping, the
  provider probe and knob removal, tests and docs.

## Migration

Additive. On the first `akm index` after upgrade the mapping is regenerated and every unit is
missing from `units`, so that run is the one-time pass; entries whose units have vectors rank
through them, the rest through lexical search until the pass completes. `entries_vec`,
`embeddings` and `embedding_salvage` are dropped once every entry has unit vectors. No
generation bump is required. Reverting is dropping one table.

## Measure first

```sql
SELECT COUNT(*) AS entries,
       SUM(length(search_text)) / 4            AS corpus_rho4_tokens,
       SUM(length(search_text) > 2048)         AS entries_truncated_today
FROM entries;

SELECT COUNT(*)                 AS fragments,
       COUNT(DISTINCT entry_id) AS entries_with_fragments,
       SUM(length(content)) / 4 AS fragment_rho4_tokens
FROM entry_fragments_fts;
```

The second query is the vector count, the storage and the one-time cost; the first says how much
of the corpus today's index never sees. Both run in seconds on the field `index.db`.
