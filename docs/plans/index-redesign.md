# The index, redesigned

Supersedes the embedding-only redesign in `index-fragment-vectors.md`, which kept the index
itself: a cache rebuilt by walking every bundle, guarded by three lock mechanisms, holding the
same text in two lexical tables and a vector table it wipes, searched through tuned weights.
That structure is the flaw. This document replaces it.

## What the index is today

`akm index` runs a pipeline of phases (source cache, walk, clean, embed, finalize;
`src/indexer/indexer.ts`, 2,900 lines) over every installed bundle. Change detection is a
per-directory fingerprint of basenames, sizes and mtimes that decides whether to re-walk a
directory; a re-walk re-derives everything in it. The result is 18 tables in `index.db`, among
them the same text three times (`entries.search_text`, `entries_fts`, `entry_fragments` plus
`entry_fragments_fts`) and each vector twice (`embeddings`, `entries_vec`) with a third copy
rescued into `embedding_salvage` before rebuilds. Because any command may spawn a background
reindex and the scheduler runs its own, three locks serialize writers (rebuild lock, writer lock,
maintenance barrier), and the field's last three reports were all lock and rebuild seams:
exit 70, exit 78, orphaned children, restart from zero, a full re-embed after a rename.

## Five rules

**1. Everything is content-addressed.** A file's bytes hash to `blob_hash`. Every derived thing
is keyed by the hash of what it was derived from: parsed document and units by `blob_hash`,
vectors by `(unit_hash, identity)`, where identity is what the provider returned (model id and
width). An unchanged file never re-derives anything. A moved or renamed file re-points one row.
A generation bump re-derives only what its schema touched; it never re-embeds, because vectors are
keyed by content and model, not by a row id or a config string.

**2. One text table, one vector table.** `units` holds every piece of text the index ranks: the
card unit of each entry (name, description, tags, hints) and one unit per markdown fragment
(header line plus fragment), each with `unit_hash`, `entry_ref`, `ordinal`, `kind`, `text`.
`units_fts` is FTS5 over that text; `units_vec` is vec0 over the same rows with `unit_hash` and
`identity` as auxiliary columns. `entries` keeps only what other commands need: ref, `blob_hash`,
provenance, the parsed document. `entries_fts`, `entry_fragments`, `entry_fragments_fts`,
`embeddings`, `entries_vec` and `embedding_salvage` are gone.

**3. Index at write time; reconcile for everything else.** Every akm path that writes an asset
(`remember`, `bundle update`, source sync, improve's writes) indexes what it wrote, inline, in the
same transaction as the file write. External edits are caught by `reconcile`: stat every file
against a `files` table of `(path, size, mtime, blob_hash)`, hash only the files whose stat
changed, derive only hashes not yet derived, delete what is gone. A stat walk of 24 thousand
files takes well under a second, so reconcile runs at the start of any command that reads the
index when the tree fingerprint moved, and on the schedule. It is idempotent and small. There is
no full rebuild, no phase pipeline, no background reindex spawned per command.

**4. Embedding is a queue, not a phase.** The work is a query: unit hashes in `units` with no
row in `units_vec` for the active identity. Any process drains some of it in provider-bounded
batches, each batch committed on its own; a killed run loses one batch and the next run computes
the same query. `akm index` is reconcile plus drain; the scheduler drains; a write path drains the
few units it just created. Limits (window, slots, a chars-per-token ratio calibrated on the
provider's own tokenizer where it has one) come from the provider.
The four sizing keys go; `concurrency` and `timeoutMs` stay optional for gateways that report
nothing.

**5. No index locks.** Every index write is an idempotent, content-addressed insert or a
re-point, in a short immediate transaction under WAL with SQLite's own busy timeout. Two processes
doing the same reconcile converge on the same rows instead of fighting. The rebuild lock, the
index writer lock, the maintenance barrier on index paths and `--skip-if-locked` go with the
rebuild they protected. Genuine `SQLITE_BUSY` after the timeout stays a transient error; it
becomes rare because writes are tiny.

## Search

One query over `units`: lexical evidence from `units_fts` (BM25) and semantic evidence from
`units_vec` for the active identity, grouped to entries by best unit, the matching unit
returned with the hit. Type filters are applied in SQL, before the candidate cap, so a filtered
type cannot be starved by a truncated pool.

Fusion was going to be reciprocal rank, so that no weight or threshold needed tuning. That was
measured against the `curate-golden` fixture and rejected. Rank-only fusion cannot tell a strong
match from a weak one — a unit matching one common word earns nearly the credit of one matching
every rare word, and a semantic-only hit ties a lexical hit — so with a weak or still-draining
embedder, noise crowds out real matches. Measured means, against the pre-redesign path at 0.933:

| configuration | mean | leapfrogs |
| --- | ---: | ---: |
| three-list reciprocal rank | 0.918 | 0 |
| one lexical pool instead of the card/fragment split | 0.918 | 0 |
| card list weighted 3x in the rank sum | 0.918 | 0 |
| tier concatenation, still rank-only | 0.855 | 0 |
| magnitude-scored lexical evidence, 0.7/0.3 split | 0.936 | 0 |

The first three being identical per case is the finding: the card/fragment split and list
weighting change nothing under rank-only fusion. What shipped keeps the calibrated BM25
transform this repository already had (`stableFtsScore`, `src/core/lexical-score.ts`) and the
proven 0.7/0.3 lexical/semantic split, now over units. `minScore` IS deleted — there is no
floor. The exact/prefix/relaxed tier ladder became a priority order that tops up to the
candidate budget rather than stopping at the first non-empty tier, because a unit is a card or
one section and a conjunctive query is rarely satisfied by any single unit.

One correction, measured after the table above and before release. Calling the shipped
configuration "magnitude-scored" overstates what the transform delivers: `stableFtsScore`'s
reference constant puts every realistic BM25 value deep into `log1p` saturation, so its whole
output band is 0.029 wide across a 320-fold range of match strength — 0.021 after the 0.7
weight, and less than any single ranking contributor. Two integration tests caught the
consequence that ten bench cases could not: a memory whose description matched a query verbatim
lost to a derived twin matching two of its three tokens. So the tier a hit came from is now
ranking evidence too, ahead of the fused score — a candidate matching every query token
outranks one matching a subset — and magnitude decides only within a tier. Recalibrating the
transform instead was tried and rejected: it cannot reach the second failing case at all,
because the score floor is a separate constant that no rescaling moves below the belief-state
ceilings. Gating the ranking contributors on tier was also tried and rejected on measurement,
at 0.917. The shipped combination holds the bench at 0.936 with the per-case table unchanged.

One fixture case regressed (`residue-docker`, 1.000 to 0.816) and is recorded rather than tuned
away; ten hand-labelled cases cannot justify fitting a constant.

## What stays

`entries` (narrowed), `index_meta`, the graph tables, `utility_scores`, `llm_enrichment_cache`
and `registry_index_cache`; each re-keyed to `blob_hash` or `entry_ref` where it is keyed to a
row id today. The provider batching, retry, back-off, circuit breaker and per-batch commit code:
it is the right way to talk to a provider.

## What goes

The phase pipeline and directory fingerprints (`indexer.ts`, `passes/dir-staleness.ts`); the
rebuild lock, writer lock, index maintenance-barrier paths and their exit-code special cases; the
salvage table and repository; the canary, the fingerprint purge and `--reembed`; the per-document
cap, the adaptive budget as a primary mechanism, `batchSize`, `contextLength`; the duplicated FTS
tables and their repository; the fusion weights and `minScore`. Roughly 4,800 lines across the
files that implement today's index core, replaced by an estimated 1,500.

## Cost, plainly

- **Derivation is CPU and fast**: hashing and parsing 24 thousand files once, then only what
  changes.
- **Embedding is paid once per model**: every unit once, roughly 21 M tokens on the field corpus
  (the query at the end gives the real number), one to three hours on one slot at the measured
  rates, a quarter on four. Never again for unchanged text, across rebuilds, renames, upgrades.
- **Storage**: unit text once (about 85 MB at 21 M tokens) plus its FTS index, against today's
  text held three times; vectors once in float32, 395 MB at the field's 1,024 dimensions for
  about 96 thousand units, against today's 98 MB held twice plus salvage.
- **Search scans every unit vector**: tens to low hundreds of milliseconds at 1,024 dimensions.
  Bounding the KNN by lexical candidates is the lever if it matters; it is measured, not assumed.
- **Migration**: a new index generation. The first run builds `files`, `entries` and `units`
  from scratch (minutes of CPU) and starts draining vectors; search works lexically from the
  first minute and semantically as the queue drains. The old `index.db` layout is dropped.
- **Risk**: every consumer of `entries` (list, show, curate, improve, graph, related) is
  exercised by the existing integration suite; the narrowed table keeps the columns they read.

## Build

Six parallel modules against one contract, one integrator, one gate:

| Module | Delivers |
| --- | --- |
| files and reconcile | `files` table, stat walk, hash-on-change, derive-on-new-hash, delete-on-gone |
| units and stores | `units`, `units_fts`, `units_vec`; card and fragment units with headers and the real-token split |
| write-time indexing | the write paths index what they wrote, inline |
| drain | the embedding queue on the existing batching code, provider limits probed |
| search | one query, magnitude-scored fusion under a lexical-tier priority, grouping, the matched unit in the hit |
| removal and migration | delete the machinery above, new generation, `akm index status`, docs |

All six shipped. The search row is the one whose deliverable changed during the
build: reciprocal-rank fusion was the plan and lost on measurement, so what shipped
scores lexical evidence by magnitude and ranks the lexical tier ahead of the fused
score — see the Search section above for the table and the two rejected alternatives.

## Measure first

These are the sizing queries that were run BEFORE the build, against the pre-redesign
schema, to get the corpus token count the Cost section quotes. They do not run on a
0.9.16 index: `entries.search_text` and `entry_fragments_fts` are both gone. The
equivalent on the new schema is `akm index status`, which reports files, entries,
distinct units and how many carry a vector for the active identity.

```sql
SELECT COUNT(*) AS entries, SUM(length(search_text)) / 4 AS corpus_rho4_tokens FROM entries;
SELECT COUNT(*) AS fragments, SUM(length(content)) / 4 AS fragment_rho4_tokens FROM entry_fragments_fts;
```
