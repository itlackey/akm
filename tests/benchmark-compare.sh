#!/usr/bin/env bash
#
# Compare search quality benchmarks between the current branch and main.
#
# Usage:
#   bash tests/benchmark-compare.sh
#   bash tests/benchmark-compare.sh <base-branch>   # default: main
#
# Output:
#   Side-by-side comparison of MRR, Recall@5, per-query metrics.
#
set -euo pipefail

BASE_BRANCH="${1:-main}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BENCHMARK_SCRIPT="$SCRIPT_DIR/benchmark-search-quality.ts"

# Ensure we're in the project root
cd "$PROJECT_DIR"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
RESULTS_DIR="$(mktemp -d)"
CURRENT_RESULTS="$RESULTS_DIR/current.json"
BASE_RESULTS="$RESULTS_DIR/base.json"

cleanup() {
  rm -rf "$RESULTS_DIR"
}
trap cleanup EXIT

echo "=== Search Quality Benchmark Comparison ==="
echo "Current branch: $CURRENT_BRANCH"
echo "Base branch:    $BASE_BRANCH"
echo ""

# ── Run benchmark on current branch ──────────────────────────────────────────

echo ">>> Running benchmark on $CURRENT_BRANCH ..."
bun run "$BENCHMARK_SCRIPT" --json > "$CURRENT_RESULTS" 2>/dev/null
echo "    Done."

# ── Stash changes and run benchmark on base branch ──────────────────────────

echo ">>> Switching to $BASE_BRANCH ..."

# Check for uncommitted changes
STASH_NEEDED=false
if ! git diff --quiet || ! git diff --staged --quiet; then
  STASH_NEEDED=true
  git stash push -m "benchmark-compare: auto-stash" --quiet
fi

git checkout "$BASE_BRANCH" --quiet 2>/dev/null

echo ">>> Running benchmark on $BASE_BRANCH ..."
bun run "$BENCHMARK_SCRIPT" --json > "$BASE_RESULTS" 2>/dev/null
echo "    Done."

# ── Return to original branch ────────────────────────────────────────────────

echo ">>> Switching back to $CURRENT_BRANCH ..."
git checkout "$CURRENT_BRANCH" --quiet 2>/dev/null

if [ "$STASH_NEEDED" = true ]; then
  git stash pop --quiet 2>/dev/null || true
fi

# ── Compare results ──────────────────────────────────────────────────────────

echo ""
echo "=== Comparison ==="
echo ""

# Use bun to parse and compare JSON
bun -e "
const fs = require('fs');

const current = JSON.parse(fs.readFileSync('$CURRENT_RESULTS', 'utf8'));
const base = JSON.parse(fs.readFileSync('$BASE_RESULTS', 'utf8'));

function fmtDelta(curr, prev) {
  const delta = curr - prev;
  const sign = delta >= 0 ? '+' : '';
  return delta === 0 ? '  (=)' : '  (' + sign + delta.toFixed(4) + ')';
}

function pad(str, len) {
  return String(str).padEnd(len);
}

console.log('Metric               ' + pad('$BASE_BRANCH', 16) + pad('$CURRENT_BRANCH', 16) + 'Delta');
console.log('-'.repeat(70));
console.log(pad('MRR', 22) + pad(base.metrics.mrr, 16) + pad(current.metrics.mrr, 16) + fmtDelta(current.metrics.mrr, base.metrics.mrr));
console.log(pad('Recall@5', 22) + pad(base.metrics.recallAt5, 16) + pad(current.metrics.recallAt5, 16) + fmtDelta(current.metrics.recallAt5, base.metrics.recallAt5));
console.log(pad('Avg Score', 22) + pad(base.metrics.avgExpectedScore, 16) + pad(current.metrics.avgExpectedScore, 16) + fmtDelta(current.metrics.avgExpectedScore, base.metrics.avgExpectedScore));
console.log(pad('Rank 1 hits', 22) + pad(base.metrics.rank1Count + '/' + base.queryCount, 16) + pad(current.metrics.rank1Count + '/' + current.queryCount, 16));
console.log(pad('Misses', 22) + pad(base.metrics.missCount + '/' + base.queryCount, 16) + pad(current.metrics.missCount + '/' + current.queryCount, 16));

console.log('');
console.log('Per-query comparison:');
console.log(pad('Query', 30) + pad('Base Rank', 12) + pad('Curr Rank', 12) + 'Change');
console.log('-'.repeat(70));

for (let i = 0; i < current.queries.length; i++) {
  const cq = current.queries[i];
  // Find matching query in base results by label
  const bq = base.queries.find(q => q.label === cq.label);
  const baseRank = bq ? (bq.rank ?? 'MISS') : 'N/A';
  const currRank = cq.rank ?? 'MISS';

  let change = '';
  if (bq && bq.rank !== null && cq.rank !== null) {
    const delta = bq.rank - cq.rank;  // positive = improved
    if (delta > 0) change = '  improved by ' + delta;
    else if (delta < 0) change = '  regressed by ' + (-delta);
    else change = '  unchanged';
  } else if (bq && bq.rank === null && cq.rank !== null) {
    change = '  NEW HIT';
  } else if (bq && bq.rank !== null && cq.rank === null) {
    change = '  LOST';
  }

  console.log(pad(cq.label, 30) + pad(baseRank, 12) + pad(currRank, 12) + change);
}
"
