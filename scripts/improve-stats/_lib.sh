#!/usr/bin/env bash
# Shared helpers for the improve-stats scripts. Source, don't exec.
#
# Storage model
# =============
# `improve_runs` rows in state.db are the authoritative store for run
# envelopes. The legacy `<stash>/.akm/runs/<id>/improve-result.json`
# layout is archived after the one-shot
# `scripts/migrations/import-fs-improve-runs-to-db.ts` backfill. These
# helpers query the DB directly via `sqlite3`. When a script needs to
# forward to `akm-eval-collect` (which still expects the FS layout),
# `stage_run_to_tmp` materialises the row back to a temp directory of
# the same shape so the collector keeps working without modification.

set -euo pipefail

# Path to state.db. Mirrors src/core/paths.ts:getStateDbPathInDataDir.
# Override with AKM_STATE_DB_PATH for tests or relocated installs.
state_db_path() {
  if [[ -n "${AKM_STATE_DB_PATH:-}" ]]; then
    echo "$AKM_STATE_DB_PATH"
    return
  fi
  local data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  echo "$data_home/akm/state.db"
}

# Stash dir resolver kept for backwards compatibility — only used when
# forwarding to akm-eval-collect through stage_run_to_tmp (so the
# collector's --stash flag has a sensible default). Priority: --stash
# flag, $AKM_STASH_DIR env, ~/akm fallback. Sets $STASH_DIR and pushes
# unknown args back into $REMAINING_ARGS.
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
        REMAINING_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

# SQL-quote a string by doubling single quotes.
sql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

# Resolve a user-supplied run identifier ("latest", "last", or an exact
# id) to a concrete row id from the DB. Echoes the id on success.
resolve_run_id() {
  local input="$1"
  local db
  db="$(state_db_path)"
  if [[ ! -f "$db" ]]; then
    echo "improve-stats: state.db not found at $db" >&2
    return 1
  fi
  if [[ "$input" == "latest" || "$input" == "last" ]]; then
    sqlite3 "$db" "SELECT id FROM improve_runs ORDER BY started_at DESC LIMIT 1;"
    return
  fi
  local hit
  hit="$(sqlite3 "$db" "SELECT id FROM improve_runs WHERE id = '$(sql_quote "$input")' LIMIT 1;")"
  if [[ -z "$hit" ]]; then
    echo "improve-stats: no run with id $input in $db" >&2
    return 1
  fi
  echo "$hit"
}

# Echo a run's result_json blob from the DB.
fetch_result_json() {
  local id="$1"
  local db
  db="$(state_db_path)"
  sqlite3 "$db" "SELECT result_json FROM improve_runs WHERE id = '$(sql_quote "$id")';"
}

# Materialise a run row into a fresh temp dir of the legacy shape so
# `akm-eval-collect --stash <root> --from-improve-run <id>` keeps
# working. Echoes the synthetic stash root on stdout. Caller is
# responsible for cleanup (caller typically: `trap 'rm -rf "$tmp"' EXIT`).
stage_run_to_tmp() {
  local id="$1"
  local tmp
  tmp="$(mktemp -d -t akm-improve-stats.XXXXXX)"
  local target_dir="$tmp/.akm/runs/$id"
  mkdir -p "$target_dir"
  fetch_result_json "$id" > "$target_dir/improve-result.json"
  echo "$tmp"
}

# Pretty timestamp for a run-id (2026-05-21T02-07-34-...) — keeps only
# the first four `-`-segments which match `YYYY-MM-DDTHH-MM`.
run_ts() {
  echo "$1" | cut -d- -f1-4
}
