# #1208 — memory inference: cache an explicit successful no-change decision

Status: **ready for review; not deployed.** Baseline is `origin/release/0.10.0` at `d6f8c537f`.
Candidate is the PR head (code `76f5b2396`, prompt repair `731288358`, evidence and docs after).

## Observed failure (reproduced on the baseline)

The prompt requires a derived memory for every note and the parser requires all five fields, so a note with
nothing to add has no valid reply. An unusable reply is `skippedNoFacts`, is never cached, and leaves the
parent pending, so the model is called again on every run. The new pass tests on the baseline: a cached or
repeated run of an unchanged note makes a second model call (`tests-on-base.txt`: 23 of 39 fail, the 16
passing are the existing tests plus the failure-handling guards that must not change).

## Contract

- Reply: `noChange: true` (all fields required by the strict schema, the rest empty). Only a literal boolean
  `true` counts. A draft with `noChange: false` or absent is validated as before.
- Result: `compressMemoryToDerivedMemory` returns the draft, `{ noChange: true }`, or `undefined`.
  `undefined` stays every failure: invalid or incomplete JSON, placeholder, HTML, timeout, abort, transport,
  disabled pass. No-change is never produced by an error path.
- Cache: the existing `llm_enrichment_cache`, key = parent path + body hash, variant bumped to
  `memory-inference-v3`. The validator accepts a complete draft or `{ noChange: true }` and returns
  `undefined` (recompute) for anything else, so old or odd rows are a disposable miss.
- Pass: a cached or fresh no-change writes no child, does not touch the parent (no `inferenceProcessed`
  stamp, byte-identical file), needs no credential when cached, and is re-asked after an edit of the body or
  on `reEnrich`. The child-exists pre-check, recovery, no-recursion and the disabled pass are unchanged.
- Accounting: **`memoryInference.noChange`** (integer, always present) in the improve result, in the progress
  event, and in health `improve.memoryInference.noChange`. It counts fresh and cached decisions, a cached one
  also in `cacheHits`. It is never in `skippedNoFacts`, `htmlErrorCount` or `unaccounted`. Health `yieldRate`
  is unchanged (`written / freshAttempts`): it measures child yield, which restraint lowers by design.

## Ordered acceptance criteria (fixed before the pilot)

1. Integrity: failures never cached or counted as no-change and are retried; recovery, no-recursion,
   credentials and the disabled pass unchanged; an edit makes the note eligible again.
2. Primary benefit: a tool-count or checkpoint note returns no-change, no child, and the repeated run makes
   zero model calls and no parent write.
3. Tradeoffs: positive controls keep producing grounded children (false abstention, useful-output quality),
   errors and completion, cost.
4. "Always no-change" must fail: positives and restraint cases are scored separately.

## Tests (deterministic boundary)

`tests/integration/memory-inference-no-change.test.ts` (real prompt, parser, cache validator and pass;
only the chat transport is scripted) and additions to `tests/llm/memory-infer.test.ts`. Existing fixtures
gained `noChange: 0`; existing cache tests use the v3 variant.

| Run | Result |
|---|---|
| New tests on the baseline | `tests-on-base.txt`: 23 fail (16 pass: unchanged behaviour) |
| New tests on the candidate | `tests-on-candidate.txt`: 39 pass, 0 fail |
| Touched and related suites (680 tests in 56 files that mention memory inference or its metrics), contracts, `tsc` | pass |

## Model pilot

Paired, same model and settings on both builds, sequential, one model server, no cloud API, public or
fictional cases only. akm-eval `evals/bakeoff --process memory-inference` at origin/main `94c3de1`
(collector/scorer 0.2) via `AKM_BIN`; `--cases` for the two author-written sets. Model:
`splinter-b70/qwen3.8-flash-next-iq2_xs` (the review's Flash-Next, listed by the gateway and probed live),
endpoint `<MODEL_BASE_URL>`, served as `qwen3.8-flash-next-iq2_xs`, temperature 0, thinking off, keyword
search, concurrency 1. Builds: baseline `d6f8c537f`; candidate `731288358`.

The bakeoff cannot score no-change (akm-eval#132: it reports `unusable`). The scored fields below come from
the samples and from `repeat-run-wrapper.sh`, which only logs the `memoryInference` counters and model calls
of the `improve` run and then runs the same `improve` once more in the same sandbox (the repeated run).

Sets: **positives** = the 8 public bakeoff memory-inference cases plus 6 fresh author-written substantive
notes; **restraint** = 5 tool-count/checkpoint/resume notes ("clear no-change") and 3 short specific notes
("adequate short"), fresh set of 4 + 2 for the final check. Cases in `pilot/`.

Treatments (budget 3, 2 used): T1 the prompt as first written. Its only deviation: the public checkpoint
case lost its explicit date (`retains explicit date` failed, 2 of 2 runs, baseline 2 of 2 passed). T2 adds
"dates" to the verbatim-fact list of the child instruction; T2 restores it (2 of 2) with identical restraint.
T2 is the candidate. The fresh set (`finalB`, 6 positives + 6 restraint) was not run before T2 was fixed.

| Measure (2 runs each, identical in both runs) | Baseline | Candidate (T2) |
|---|---|---|
| Positive controls (14): children written / false abstentions | 14 / 0 | 14 / 0 |
| Positive useful-output (scored checks, public 8) | 8 of 8 | 8 of 8 (T1: 7 of 8) |
| Positive useful-output (fresh 6) | 6 of 6 | 6 of 6 |
| Clear no-change notes (9): unnecessary children | 9 of 9 | 0 of 9 (9 no-change) |
| Adequate short notes (5): children / no-change | 5 / 0 | 5 / 0 |
| Errors, failed model calls, `skippedNoFacts`, HTML | 0 | 0 |
| Repeated run, model calls on the 9 no-change notes | n/a (baseline wrote a child, so 0 calls) | 0 (9 cache hits, parents unmodified) |
| Median seconds per case | 3.5–4.2 | 2.5 (no-change) – 4.2 |

Per-case outcomes are in `results.json` and the raw samples in `raw/`. The baseline cannot show the
repeated-call cost on this model because it never fails to write a child; the deterministic tests show it
for an unusable reply. The scorer's `case_pass` on the two author-written sets is not a quality figure
(two fresh restraint cases use placeholder expected terms that fail on both builds: `resuming`, `` `make ``;
the restraint sets expect nothing of a no-change note). No private asset, endpoint or cloud model was used.

## Limits and what is left

- The model never abstained on the 5 adequate short notes (3 + 2). That is conservative by design in the
  prompt ("when in doubt, do not use noChange"); I did not tune for it. Raw child yield is not the goal.
- One model, one prompt, a pilot of 28 notes with 2 repeats: it shows restraint and no false abstention on
  these cases, not a general rate. akm-eval#132 should score no-change and false abstention properly.
- #1209 (source context in the prompt) is not implemented. The cache identity today is the body hash, which
  is everything the model sees. When #1209 adds metadata to the prompt it must add it to that identity
  (`computeBodyHash(record.body)` in `planPendingMemoryRecord` and the `withLlmCache` call in
  `inferPendingMemoryRecord`) and bump `MEMORY_INFERENCE_CACHE_VARIANT` again.
- Rollout: code-only. Old `memory-inference-v2` rows stay unread in `llm_enrichment_cache`; no migration.
  The first run after install re-asks the model for any parent that was pending with a v2 row. Existing
  children are never deleted.
