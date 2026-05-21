#!/usr/bin/env bash
#
# AKM data directory restoration helper (MVP).
#
# When a destructive `DB_VERSION` upgrade has wiped data you needed, this
# script rolls the live data directory back to a pre-upgrade snapshot written
# by AKM (see src/indexer/db-backup.ts).
#
# It is intentionally non-destructive about your current state: the existing
# data dir contents are MOVED aside (not deleted) so you can still pick out
# rows that arrived after the upgrade if you want them later.
#
# Usage:
#   bash scripts/migrations/restore-data-dir.sh <backup-dir> <live-data-dir>
#
# Example:
#   bash scripts/migrations/restore-data-dir.sh \
#       ~/.local/share/akm/backups/2026-05-19T04-59-36-pre-v17 \
#       ~/.local/share/akm
#
# IMPORTANT — stop every running `akm` process before running this. The
# script checks for the lockfile and aborts if one is held, but it cannot
# detect background daemons or other shells that opened the DB read-only.

set -euo pipefail

usage() {
  cat >&2 <<EOF
Usage: $0 <backup-dir> <live-data-dir>

  <backup-dir>     Path to an AKM pre-upgrade snapshot, e.g.
                   ~/.local/share/akm/backups/2026-05-19T04-59-36-pre-v17
  <live-data-dir>  Path to the active AKM data dir, e.g.
                   ~/.local/share/akm
EOF
  exit 2
}

if [[ $# -ne 2 ]]; then
  usage
fi

BACKUP="$1"
LIVE="$2"

if [[ ! -d "$BACKUP" ]]; then
  echo "error: backup directory does not exist: $BACKUP" >&2
  exit 1
fi

if [[ ! -d "$LIVE" ]]; then
  echo "error: live data directory does not exist: $LIVE" >&2
  exit 1
fi

# Refuse to operate when the backup and live paths are the same — that would
# be a no-op at best, data loss at worst.
if [[ "$(cd "$BACKUP" && pwd)" == "$(cd "$LIVE" && pwd)" ]]; then
  echo "error: backup and live paths resolve to the same directory" >&2
  exit 1
fi

# Best-effort lockfile check. AKM writes akm.lock when a process holds the
# data dir; if it's there, refuse to restore.
if [[ -f "$LIVE/akm.lock" ]]; then
  echo "error: $LIVE/akm.lock exists — another akm process may be running." >&2
  echo "       Stop it (or remove the stale lockfile if you're sure) and retry." >&2
  exit 1
fi

ASIDE="${LIVE}.before-restore"
if [[ -e "$ASIDE" ]]; then
  echo "error: aside path already exists: $ASIDE" >&2
  echo "       Move or delete it before retrying so we don't overwrite a prior rollback." >&2
  exit 1
fi

echo "[restore] moving current data dir aside: $LIVE -> $ASIDE" >&2
mv -- "$LIVE" "$ASIDE"

echo "[restore] creating fresh live data dir: $LIVE" >&2
mkdir -p -- "$LIVE"

echo "[restore] copying backup contents: $BACKUP/* -> $LIVE/" >&2
# Use -a to preserve mtimes; copy the contents (not the backup dir itself).
# Quoting the glob with shopt nullglob protects against an empty backup dir
# (extremely unlikely, but we'd rather error than silently produce an empty
# live dir).
shopt -s dotglob nullglob
items=("$BACKUP"/*)
if [[ ${#items[@]} -eq 0 ]]; then
  echo "error: backup directory is empty: $BACKUP" >&2
  echo "       Restoring it would produce an empty live dir; aborting." >&2
  # Roll back our aside-move so the operator isn't left worse off.
  rmdir -- "$LIVE" || true
  mv -- "$ASIDE" "$LIVE"
  exit 1
fi
cp -a -- "${items[@]}" "$LIVE/"

# Don't carry forward the backup's own backup.meta.json into the live dir —
# it describes the snapshot, not the live state.
rm -f -- "$LIVE/backup.meta.json"

echo "[restore] done. Previous state preserved at: $ASIDE" >&2
echo "[restore] next steps:" >&2
echo "          1. Start akm with the binary version that wrote the backup," >&2
echo "             OR accept that the next upgrade will re-snapshot and rebuild." >&2
echo "          2. When you're sure you don't need the post-upgrade state," >&2
echo "             remove the aside dir: rm -rf '$ASIDE'" >&2
