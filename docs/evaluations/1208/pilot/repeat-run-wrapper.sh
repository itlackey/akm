#!/usr/bin/env bash
# usage: wrap.sh LOGDIR LABEL CLI_TS args...   Runs akm from CLI_TS. For `improve` it runs the command a second time in the
# same sandbox (the repeated run) and logs the memory-inference counters and model calls of both runs. The first run's output is
# what the caller sees.
logdir=$1; label=$2; cli=$3; shift 3
if [[ " $* " != *" improve "* ]]; then exec bun "$cli" "$@"; fi
mkdir -p "$logdir"
note=$(ls "$AKM_BUNDLE_DIR/memories" 2>/dev/null | grep -v '\.derived\.md$' | head -1)
out1=$(mktemp); out2=$(mktemp)
bun "$cli" "$@" > "$out1"; rc=$?
bun "$cli" "$@" > "$out2" 2>/dev/null
python3 - "$logdir/$label.jsonl" "$note" "$out1" "$out2" "$AKM_BUNDLE_DIR" <<'PY'
import json, sys, os
log, note, f1, f2, bundle = sys.argv[1:6]
def summ(path):
    try:
        d = json.load(open(path))
    except Exception as e:
        return {"unparsed": str(e)[:80]}
    mi = d.get("memoryInference") or {}
    calls = sum(p.get("calls", 0) for p in (d.get("usageReport", {}).get("byProcessEngineModel") or []) if p.get("process") == "memoryInference")
    fails = sum(p.get("failures", 0) for p in (d.get("usageReport", {}).get("byProcessEngineModel") or []) if p.get("process") == "memoryInference")
    keys = ["considered", "cacheHits", "splitParents", "writtenFacts", "noChange", "skippedNoFacts", "skippedChildExists", "htmlErrorCount", "retryAttempts"]
    return {"mi": {k: mi.get(k) for k in keys if k in mi}, "modelCalls": calls, "failedCalls": fails}
child = os.path.exists(os.path.join(bundle, "memories", note.replace(".md", ".derived.md")))
with open(log, "a") as fh:
    fh.write(json.dumps({"note": note, "child": child, "run1": summ(f1), "run2": summ(f2)}) + "\n")
PY
cat "$out1"; rm -f "$out1" "$out2"
exit $rc
