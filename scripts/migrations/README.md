# AKM migration helper scripts

When AKM ships a destructive DB schema change (the `handleVersionUpgrade()`
path in `src/indexer/db/db.ts` drops every table and forces a full reindex), the
running binary writes a pre-upgrade snapshot of the entire data directory to:

```
$XDG_DATA_HOME/akm/backups/<timestamp>-pre-v<targetVersion>/
```

(or `$AKM_DATA_DIR/backups/...` when overridden — see
[docs/configuration.md](../../docs/configuration.md) for the data-directory
resolution rules.)

These backups are dumb `fs.cpSync` recursive copies of the live data dir as it
existed *before* the upgrade. They are **not** a migration in the database
sense — they're a snapshot you can scavenge for rows the upgrade dropped.

The scripts in this directory provide a starting template for that scavenging
work. They are intentionally **ad-hoc and per-transition**: each
`v<N>-to-v<M>.ts` file knows which tables the upgrade clobbered and how to
re-insert the rows that mattered.

## When to use these

You almost never need to. The default `akm` upgrade preserves `usage_events`
across version bumps and rebuilds everything else from your stash on the next
`akm index`. Reach for these scripts only when:

1. You upgraded across a version boundary that dropped a table you cared
   about (e.g. derived utility scores, graph extraction state).
2. Reindexing won't recover the data (because the source files have changed,
   been removed, or the data was never sourced from files in the first place).
3. You have a backup directory written by the running binary at upgrade time.

## Calling convention

Every helper accepts the same two flags:

```sh
bun scripts/migrations/v16-to-v17.ts \
    --backup /home/$USER/.local/share/akm/backups/2026-05-19T04-59-36-pre-v17 \
    --target /home/$USER/.local/share/akm/index.db
```

- `--backup <path>` — path to a backup directory **or** directly to a backup
  `index.db` file. The script will look inside the directory if you pass one.
- `--target <path>` — path to the **current, live** `index.db` you want to
  re-populate. The script writes to this DB in place; **make a side copy
  first** if you want a safety net.

All scripts emit a JSON summary on stdout when they finish:

```json
{
  "from": "v16",
  "to": "v17",
  "tablesReconciled": ["usage_events"],
  "rowsInspected": 1234,
  "rowsInserted": 5,
  "rowsSkipped": 1229,
  "durationMs": 87
}
```

## Restoring the entire data dir

If the upgrade destroyed more than you can re-derive with a targeted script,
you can roll the data dir back wholesale with
[`restore-data-dir.sh`](./restore-data-dir.sh):

```sh
# 1. Stop every running akm process / daemon.
# 2. Run the restore script.
bash scripts/migrations/restore-data-dir.sh \
    /home/$USER/.local/share/akm/backups/2026-05-19T04-59-36-pre-v17 \
    /home/$USER/.local/share/akm
```

This **moves** the current data dir contents aside to `<live>.before-restore/`
(non-destructive — you can still read the post-upgrade state if you need it)
and copies the backup contents over the live location.

After restoring, you'll need to re-run any binary that bumped `DB_VERSION` —
which will trigger another backup + destructive upgrade. Pin to the binary
version that matches your backup before restoring, or accept that the next
upgrade will re-snapshot before reapplying the schema change.

## Writing a new helper

Use `v16-to-v17.ts` as the canonical template. The pattern:

1. Open the backup DB read-only.
2. Open the target DB writable.
3. For each table you care about, define a **stable key** (typically a tuple
   of columns that uniquely identify a row across schema variants — e.g.
   `(created_at, event_type, entry_ref)` for `usage_events`).
4. Stream rows from the backup, look up each by stable key in the target, and
   insert if absent. Skip if present; do **not** clobber on conflict — the
   target may have post-upgrade events the operator wants to keep.
5. Emit the JSON summary on stdout. Use stderr for progress / warnings.

Keep scripts side-effect free except for the writes you intend. Never delete
from the target DB. Never delete from the backup. The operator can throw the
backup away themselves when they're confident the data is recovered.
