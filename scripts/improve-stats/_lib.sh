#!/usr/bin/env bash
# Shared helpers for the improve-stats scripts. Source, don't exec.

set -euo pipefail

# Resolve the stash directory. Priority: --stash flag, $AKM_STASH_DIR env,
# ~/akm fallback. Sets $STASH_DIR.
resolve_stash() {
  STASH_DIR="${AKM_STASH_DIR:-$HOME/akm}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --stash)
        STASH_DIR="$2"
        shift 2
        ;;
      --stash=*)
        STASH_DIR="${1#--stash=}"
        shift
        ;;
      *)
        # Leave unknown args for the caller — preserve $@ via REMAINING_ARGS.
        REMAINING_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

# Print absolute path of the runs directory.
runs_dir() {
  echo "$STASH_DIR/.akm/runs"
}

# Print the path to a run's improve-result.json given a run identifier.
# Accepts a full run-id (directory name) or "latest" / "last".
run_path() {
  local id="$1"
  local rd
  rd="$(runs_dir)"
  if [[ "$id" == "latest" || "$id" == "last" ]]; then
    id="$(ls -t "$rd" 2>/dev/null | head -1)"
    if [[ -z "$id" ]]; then
      echo "no runs found under $rd" >&2
      return 1
    fi
  fi
  local path="$rd/$id/improve-result.json"
  if [[ ! -f "$path" ]]; then
    echo "no improve-result.json at $path" >&2
    return 1
  fi
  echo "$path"
}

# Pretty timestamp for the run directory name (2026-05-21T02-07-34-...).
run_ts() {
  echo "$1" | cut -d- -f1-4
}
