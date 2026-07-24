# Improve Effectiveness

`improve-effectiveness` is a deterministic, non-ceiling twin suite. Its representative flaw is an exact duplicate derived memory: control retrieves both copies, while current improve's high-confidence memory cleanup archives the duplicate and keeps the canonical copy. A separate unrelated anchor protects retrieval health. The suite does not use LLM judging.

## Expected scores

Both cases are deterministic retrieval cases with equal weight inside the retrieval bucket:

- Frozen control: `target-retrieval-lift=0.3`, `protected-anchor-retrieval=1`, overall/deterministic `0.65`.
- Expected treatment: both cases score `1`, overall/deterministic `1.0`.
- Expected lift: `+0.35`; the recommended predeclared minimum is `+0.30`.

The target case reserves `0.3` for preserving the canonical memory and `0.7` for removing the redundant result. The tagged protected case gates index/search health, exact anchor retrieval, and exclusion of both recovery memories from an unrelated query. Neither case has state-dependent skip requirements, so both arms have identical skip eligibility. Any arm-only skip is already made inconclusive by `akm-eval-twin`.

## Seed and freeze

Run from the repository root. Use an isolated installation; do not add these fixtures to a real stash. Set `LLM_ENDPOINT` and `LLM_MODEL` to the same serving identity described by the endpoint metadata used for the twin run.

```sh
export SUITE_DIR="$PWD/scripts/akm-eval/cases/improve-effectiveness"
export BENCH_ROOT="$HOME/.cache/akm-eval/improve-effectiveness"
export STASH="$BENCH_ROOT/stash"
export DATA="$BENCH_ROOT/data"
export CONFIG="$BENCH_ROOT/config"
export SNAPSHOT="$HOME/.cache/akm-eval/snapshots/improve-effectiveness-v1"
export LLM_ENDPOINT="http://127.0.0.1:1234/v1/chat/completions"
export LLM_MODEL="replace-with-served-model-id"

test ! -e "$BENCH_ROOT" && test ! -e "$SNAPSHOT"
mkdir -p "$STASH" "$DATA" "$CONFIG" "$BENCH_ROOT/cache" "$BENCH_ROOT/state"
cp -R "$SUITE_DIR/fixtures/corpus/." "$STASH/"
chmod -R go-rwx "$BENCH_ROOT"

export AKM_STASH_DIR="$STASH"
export AKM_DATA_DIR="$DATA"
export AKM_CONFIG_DIR="$CONFIG"
export AKM_CACHE_DIR="$BENCH_ROOT/cache"
export AKM_STATE_DIR="$BENCH_ROOT/state"

cat > "$CONFIG/config.json" <<JSON
{
  "configVersion": "0.9.0",
  "semanticSearchMode": "off",
  "defaultBundle": "improve-effectiveness",
  "bundles": {
    "improve-effectiveness": {
      "path": "$STASH",
      "writable": true
    }
  },
  "engines": {
    "eval-llm": {
      "kind": "llm",
      "endpoint": "$LLM_ENDPOINT",
      "model": "$LLM_MODEL",
      "temperature": 0,
      "supportsJsonSchema": true
    }
  },
  "defaults": {
    "engine": "eval-llm",
    "llmEngine": "eval-llm",
    "improveStrategy": "reflect-distill"
  }
}
JSON

src/cli.ts index --full
src/cli.ts feedback improve-effectiveness//memories/database-restore --negative \
  --failure-mode incomplete \
  --reason "Add the missing PostgreSQL point-in-time recovery, WAL archive, and checksum procedure."

scripts/akm-eval/bin/akm-eval-run --suite improve-effectiveness \
  --stash "$STASH" --akm "$PWD/src/cli.ts" --out "$BENCH_ROOT/preflight" --format json

chmod -R go-rwx "$BENCH_ROOT"
scripts/akm-eval/bin/akm-eval-snapshot capture \
  --out "$SNAPSHOT" \
  --config "$CONFIG/config.json" \
  --data "$DATA" \
  --bundle "improve-effectiveness=$STASH" \
  --producer-version "$(bun -p 'require("./package.json").version')" \
  --producer-commit "$(git rev-parse HEAD)"
```

The preflight score must be `0.65`, both derived files must still be live, and the parent feedback must be less than 30 days old. Refresh the feedback and recapture rather than reusing a stale snapshot. The event uses a durable bundle-qualified ref, so it remains eligible after snapshot relocation; unlike proposal rows, it does not depend on an absolute `stash_dir`.

The duplicate pair has byte-identical content and provenance. Improve's deterministic cleanup selects `memories/database-restore.derived` as survivor and archives `memories/database-restore-copy.derived` during the live run. The recent parent feedback plus `memory --require-feedback-signal --limit 1` also sends the parent through the configured reflect/distill LLM path, making treatment LLM telemetry and identity mandatory for a conclusive twin result.

## Recommended twin command

Create the mode-0600 endpoint metadata/runtime files described in `scripts/akm-eval/README.md`, then run:

```sh
scripts/akm-eval/bin/akm-eval-twin \
  --snapshot "$SNAPSHOT" \
  --suite improve-effectiveness \
  --akm "bun $PWD/src/cli.ts" \
  --out "$HOME/.cache/akm-eval/results" \
  --samples 2 --required-samples 2 \
  --policy current \
  --improve-args "memory --strategy reflect-distill --require-feedback-signal --limit 1 --task Add the missing PostgreSQL point-in-time recovery, WAL archive, and checksum procedure" \
  --endpoint-metadata "$ENDPOINT_METADATA" \
  --endpoint-assignment "$ENDPOINT_ID" \
  --endpoint-runtime "$ENDPOINT_RUNTIME" \
  --minimum-deterministic-lift 0.30 \
  --protected-loss-margin 0 \
  --max-treatment-tokens 200000 \
  --max-treatment-calls 20 \
  --max-treatment-duration-ms 1200000 \
  --command-timeout-ms 1200000
```

The suite's protected tag is discovered automatically. A passing experiment means mean deterministic lift met `0.30`, the protected anchor had no loss, all samples were conclusive, treatment LLM identity/telemetry were complete, and the aggregate treatment resource budgets were respected.

## Limitations

- The scored lift is the deterministic duplicate-cleanup outcome. The same treatment run's LLM-generated proposals are queued for later review and are not credited immediately.
- Exact results require the isolated fixture corpus, keyword search (`semanticSearchMode: off`), fresh parent feedback, and the documented strategy arguments.
- This measures one representative retrieval-duplication failure, not broad content quality or downstream task success.
