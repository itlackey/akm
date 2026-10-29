# Complete consolidation evidence (#1195)

`cases.jsonl` uses akm-eval's existing consolidation corpus format and scorer.
It contains one long paraphrased duplicate and four subsumed pairs with a unique
recovery requirement before, across, or after the former 12,000-character cutoff.
The unique side, age ordering, equal dates, and multibyte padding vary. Repeated
fictional prose isolates evidence position; it is not a representative corpus of
arbitrary long documents. The deterministic AKM tests cover exact UTF-16 offsets.

`exact-duplicate/cases.jsonl` is a separate final control with identical full
bodies and related filenames. It checks that a long duplicate can still retire.
The independently authored public akm-eval pairs and pool supply the short-note
regression collection; these synthetic notes are not claimed as held-out data.

`independent-source/cases.jsonl` uses prose from the baseline's
[architecture document](../../../docs/architecture/architecture.md), authored
independently of this tuning. One pair is identical; the other omits the final
SQLite/vector fact beyond the old cutoff. These two cases were reserved until
tuning stopped. Their labels are mechanically derived from that omission;
this is not a claim of a general held-out benchmark. The final control run
combines them with the unchanged exact-duplicate control.

From an akm-eval checkout, use its current runner help, then:

```sh
evals/consolidate/run --cases /path/to/akm/tests/fixtures/consolidate-complete-evidence \
  --akm 'bun /path/to/akm/src/cli.ts' --label complete-evidence
evals/consolidate/run --cases /path/to/akm/tests/fixtures/consolidate-complete-evidence/exact-duplicate \
  --akm 'bun /path/to/akm/src/cli.ts' --label complete-evidence-exact
```

Those commands use the runner's deterministic embedder. The #1195 comparison
uses `--embedder real` with the owner's private remote-embedding config patch.
No scorer or collector changes are needed. The PR is the change record; its
linked artifacts include inputs, raw scored outputs, comparisons, installed-path
HTTP requests, acceptance, and outstanding production rollout.
