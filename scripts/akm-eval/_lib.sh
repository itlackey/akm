#!/usr/bin/env bash
# Shared helpers for akm-eval bin scripts. Mirrors scripts/improve-stats/_lib.sh.

set -euo pipefail

akm_eval_dir() {
  # Directory containing this _lib.sh (resolved through symlinks).
  local src="${BASH_SOURCE[0]}"
  while [[ -h "$src" ]]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" && pwd
}

stash_dir() {
  # Caller may pre-set STASH_DIR (e.g. via --stash parsing); otherwise fall
  # back to env var, then ~/akm.
  if [[ -n "${STASH_DIR:-}" ]]; then
    echo "$STASH_DIR"
    return
  fi
  echo "${AKM_STASH_DIR:-$HOME/akm}"
}

evals_runs_dir() {
  echo "$(stash_dir)/.akm/evals/runs"
}

latest_run_dir() {
  local rd
  rd="$(evals_runs_dir)"
  if [[ -L "$rd/latest" ]]; then
    readlink -f "$rd/latest"
  elif [[ -f "$rd/latest.txt" ]]; then
    echo "$rd/$(cat "$rd/latest.txt")"
  else
    ls -1dt "$rd"/*/ 2>/dev/null | head -n 1 | sed 's:/$::'
  fi
}

require_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "akm-eval requires bun (https://bun.sh)" >&2
    exit 127
  fi
}

# Parse a --stash <path> flag out of the script's args. Sets STASH_DIR if
# present and echoes the remaining args (whitespace-safe via printf %q).
strip_stash_flag() {
  local out=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --stash)
        STASH_DIR="${2:-}"
        shift 2
        ;;
      --stash=*)
        STASH_DIR="${1#--stash=}"
        shift
        ;;
      *)
        out+=("$1")
        shift
        ;;
    esac
  done
  export STASH_DIR
  printf '%q ' "${out[@]}"
}
