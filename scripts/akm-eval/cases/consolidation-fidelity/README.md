# Consolidation Fidelity Measurement

The dedicated runner sends each fixture's sources, but not its authored claims
or calibration candidate, to `qwen/qwen3.5-9b`. It runs sequentially at
temperature 0 with thinking disabled, requires that every response report that
exact model ID, and then applies deterministic claim, forbidden-claim,
direct-provenance, and negation scoring.

`fixtures/holdout-manifest.json` is a separately authored blind holdout. Its
semantic-scope, direct-versus-indirect provenance, negation, and bounded
compression cases were sealed before any model completion was collected and
must not be edited in response to model wording. The embedded safe/lossy
candidates calibrate only the deterministic oracle.

Run it against Don's LM Studio endpoint from the repository root:

```sh
OUT="$HOME/.cache/akm-eval/consolidation-fidelity/$(date -u +%Y%m%dT%H%M%SZ)"
scripts/akm-eval/bin/akm-eval-consolidation-fidelity \
  --endpoint http://192.168.0.205:1234 \
  --manifest scripts/akm-eval/cases/consolidation-fidelity/fixtures/holdout-manifest.json \
  --out "$OUT"
```

The new output directory contains:

- `eval-result.json`: response-observed model identity, manifest fingerprint,
  validity, token totals, and aggregate `semanticScore`, `provenanceScore`, and
  `negationScore`.
- `case-results.jsonl`: each raw completion, parsed candidate, and full oracle
  result.

A well-formed low-quality model output is a conclusive failed case. Transport
failures or missing/mismatched response-observed model IDs make the run
inconclusive and exit non-zero.
