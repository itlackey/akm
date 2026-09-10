# Fragment vectors, lean

A design for akm's semantic index that answers four questions with one change: why embed a
truncated document when the fragments already exist; why truncate at all; why so many knobs;
and how to make the index cheaper to keep up to date. It is written to be built in days by one
engineer, on top of code that already exists, with its costs stated rather than modelled away.

## What changes

akm already cuts every markdown body into fragments of at most 1,600 characters and indexes each
one lexically (`entry_fragments_fts`, one row per fragment). Today the semantic side ignores them:
it embeds one vector per entry from the entry's search text, cut at 512 estimated tokens, so two
thirds of the corpus never reaches the vector index.

After this change the unit of embedding is the fragment. Every fragment gets one vector. The entry
vector is the mean of its fragment vectors, computed locally. Nothing is truncated, nothing
unchanged is ever re-sent, and vectors are stored as 8-bit integers so the index and every search
stay about the size they are today.

## Data model

| Table | Role | Change |
| --- | --- | --- |
| `entry_fragments_fts` | one row per fragment: `entry_id`, `fragment_id`, `fragment_ordinal`, `content` | unchanged; it is the source of the units |
| `fragment_vec` (new, vec0) | `fragment_id INTEGER PRIMARY KEY, embedding int8[dim]` | the search index |
| `fragment_embeddings` (new) | `fragment_id, entry_id, content_hash, fingerprint` | maps vectors to entries; carries the hash that skips re-embedding |
| `entries_vec` | one int8 centroid per entry | kept for callers that rank entries; type changes from `float[dim]` to `int8[dim]` |
| `embedding_salvage` | `content_hash → embedding` | unchanged shape; stores the same int8 bytes that go into `fragment_vec` |
| `embeddings` (float BLOB per entry) | today's second copy of the entry vector | dropped |

The unit text is the fragment's content prefixed by a short header: the entry's name and the
heading path the fragment sits under. The header costs a few tokens per fragment and is what lets
a fragment match a query that names the document, not only the passage.

A fragment that exceeds the provider's real window is split at the last line boundary before the
bound into ordinal sub-units that share the fragment's hash family; the published fragment is never
re-cut. The bound is the provider's window measured in real tokens, from `/tokenize` where the
endpoint has one, otherwise from a chars-per-token ratio calibrated on a sample at first run.

## Search

The KNN runs over `fragment_vec`, k set to the requested result count times the observed mean
fragments per entry, then groups by entry. An entry's semantic score is the best cosine among its
fragments (with the mean of its top two as the pre-registered alternative if long documents crowd
out short ones on the existing `curate-golden` fixture). The fused ranking, `0.7 × lexical + 0.3 ×
semantic` per entry, is unchanged. Results can point at the matching fragment, which today's index
cannot do.

## Why int8, and what it costs

**Why.** A fragment index has about four times as many vectors as an entry index (4.0 fragments per
entry on the field corpus, 96 thousand rows). In float32 at the field's 1,024 dimensions that is
395 MB, four times today's 98.5 MB entry table, and every search scans it. sqlite-vec has no
approximate index; a search reads every row. Storing int8 divides both numbers by four: 99 MB on
disk and 99 MB scanned per search, the same as today. The vendored sqlite-vec (0.1.9) supports
`int8[N]` columns natively, with `vec_int8` and `vec_quantize_int8` in the binary, so there is no
second table, no float re-rank pass, and no new dependency.

**What it costs.**

- *Precision.* Rounding each component to 256 levels moves cosine scores slightly. On
  normalised embeddings of this size the published effect is a fraction of a point to about two
  points of recall at ten; the number for akm is measured on `curate-golden` before shipping, and
  if it exceeds one point the design falls back to float32 at four times the storage. That fallback
  is a decision made once from the measurement, not a runtime option.
- *A scale factor.* Unit-norm vectors have small components, so mapping the range −1..1 onto
  −128..127 (what `vec_quantize_int8` does) would waste most of the levels. akm quantises in
  JavaScript with one global scale per model: 127 divided by the largest component magnitude seen in
  the first batch, with a fixed 25 percent headroom to absorb later outliers, which are clipped.
  The scale is stored in `index_meta` and becomes part of the embedding fingerprint, so a model
  change re-derives it and re-embeds, exactly as a model change does today. L2 and cosine distances
  on a globally scaled int8 vector rank the same way as on the floats.
- *No exact floats anywhere.* Salvage keeps the int8 bytes, not floats. A re-quantisation is
  therefore impossible without re-embedding; it is never needed as long as the scale is pinned to
  the fingerprint. The entry centroid is computed from int8 fragment vectors and is slightly noisier
  than a float mean; centroids only serve entry-to-entry ranking, where that is acceptable.
- *One more embedder-shaped detail.* Quantisation runs after the provider returns floats, in the
  batch commit that already exists; about twenty lines.

## Cost of the change

- *First pass.* Every fragment once. On the fitted field corpus that is about 21 M real tokens
  plus about five percent of headers: roughly 165 minutes on the slow embedder at 2,100 tokens per
  second, 75 on the fast chain, and a quarter of that with four slots. This is paid once per model.
  The real figure comes from one query on the field index (below); the fit is a placeholder.
- *Steady state.* Only fragments whose content hash changed. On 182 real edits to long documents
  in this repository, 94 percent of fragment vectors survived an edit unchanged.
- *Storage.* About today's size for the vector index at any dimension, plus the small
  `fragment_embeddings` table (under 10 MB).
- *Search.* About today's bytes per search, four times the rows, one KNN instead of one.

## Knobs

Removed, with the derived rule that replaces each:

| Key | Replaced by |
| --- | --- |
| `embedding.maxInputTokens` | the unit bound is the provider's real window; oversized units are split, never cut |
| `embedding.maxTokens` | requests are packed to the measured window minus the header margin; the same-run adaptive shrink from 0.9.15 stays as the corrective when a provider reports nothing |
| `embedding.batchSize` | nothing; once every unit is bounded, a document count guards nothing |
| `embedding.contextLength` | the measured window; sent as Ollama `num_ctx` when the provider is Ollama |

Kept, optional, derived when unset: `embedding.concurrency` (from llama.cpp `total_slots` or Ollama
`num_parallel`, else 1) and `embedding.timeoutMs` (from observed latency per token with a floor).
They survive because a gateway such as Bifrost reports neither slots nor window, and the field runs
through one; without the concurrency key a four-slot server behind a gateway would run at one slot.
One named constant remains for a provider that reports no window at all: 8,192 tokens, the most
common embedding window, with the adaptive shrink correcting it within the first run.

Net: four keys removed, none added, two kept and made optional.

## Migration

Additive. New tables are created on first run; `entries_vec` is rebuilt as int8 when its schema is
first found to be float. The first `akm index` after upgrade embeds every fragment; while it runs,
entries that already have fragment vectors rank through them and the rest rank through their old
entry vector, so search never goes dark. No index-generation bump is required. Reverting is
dropping two tables.

## Effort

About nine days for one engineer, using the batching, retry, circuit breaker, per-batch commit,
salvage, canary, and lock code that already exists:

| Work | Days |
| --- | --- |
| tables, int8 quantisation, scale in the fingerprint | 1.5 |
| fragment units, headers, real-token split, hash reuse through salvage | 2 |
| embed loop on fragments, centroid per entry | 1 |
| search over fragments, grouping, fixture measurement | 1.5 |
| provider probe, tokenizer, knob removal and schema | 2 |
| tests, docs, migration note | 1 |

## What this deliberately does not do

No summaries or representation tiers. No work ledger or utility ordering. No two-phase rollout, no
new evaluation harness beyond the fixture that exists, no external benchmark. If the one-time pass
is unacceptable on the owner's hardware, the honest alternative is to keep today's one vector per
entry and only improve what goes into it; this design does not pretend otherwise.

## Measure first

```sql
SELECT COUNT(*) AS entries,
       SUM(length(search_text)) / 4                    AS corpus_rho4_tokens,
       SUM(MIN(length(search_text), 2048)) / 4         AS baseline_rho4_tokens,
       SUM(length(search_text) > 2048)                 AS entries_truncated_today
FROM entries;

SELECT COUNT(*) AS fragments,
       COUNT(DISTINCT entry_id) AS entries_with_fragments,
       SUM(length(content)) / 4 AS fragment_rho4_tokens
FROM entry_fragments_fts;
```

The first query is the one-time cost; the second is the vector count and the storage. Both run in
seconds on the field `index.db` and replace every fitted number above.
