---
name: migrate-storage
description: Guide an agent through migrating akm storage from legacy flat-file locations to the new XDG-compliant directory structure (state.db, $DATA, $STATE).
when_to_use: When a user has upgraded akm to v0.9+ and wants to migrate their existing event log, workflow database, and task history to the new storage layout.
---

You are helping a user migrate their akm data from legacy flat-file locations to the new XDG-compliant directory structure introduced in akm v0.9+.

The migration script (`scripts/migrate-storage.ts`) is non-destructive: it copies data to new locations and leaves the originals in place. The user can delete old files manually after verifying everything works.

## Step 1 — Check that the migration script is available

Run:
```
ls scripts/migrate-storage.ts
```

If the file does not exist, tell the user to download it from the akm repository or install it via `akm install command:migrate-storage`. Do not proceed until the script is present.

## Step 2 — Run a dry-run first

Run the script in dry-run mode to show the user exactly what will happen:
```
bun scripts/migrate-storage.ts --dry-run
```

Review the output with the user. The dry run will show:
- Which source files exist and where they are (`$CACHE`, `$CONFIG`)
- Which destination directories will be used (`$DATA`, `$STATE`)
- Which steps will be skipped (source not found or destination already exists)
- Which steps would actually copy data

Ask the user if the listed source and destination paths look correct before continuing. If env overrides like `AKM_CACHE_DIR`, `AKM_DATA_DIR`, or `AKM_STATE_DIR` are set, confirm they are intentional.

## Step 3 — Run the migration

Once the user is satisfied with the dry-run output, run the migration with the `--yes` flag to skip the interactive prompt:
```
bun scripts/migrate-storage.ts --yes
```

Or without `--yes` to let the user confirm interactively:
```
bun scripts/migrate-storage.ts
```

Wait for the script to complete and review the final summary with the user.

## Step 4 — Verify the new files exist

After the migration, confirm the new files are in place. Run:
```
ls ~/.local/share/akm/
ls ~/.local/state/akm/
```

(Adjust paths if `AKM_DATA_DIR` or `AKM_STATE_DIR` are overridden.)

Expected contents of `$DATA` (`~/.local/share/akm/`):
- `index.db`
- `workflow.db`
- `state.db` (created on first event write, may not appear until akm runs)
- `akm.lock`
- `config-backups/` (if backups existed)

Expected contents of `$STATE` (`~/.local/state/akm/`):
- `tasks/history/*.jsonl` (if task history existed)

If any expected files are missing, check the "Failed" section of the migration summary for errors. Each step is independent, so failures in one step do not affect others.

## Step 5 — Optional: clean up old files

The migration script deliberately leaves old files in place. Once the user has verified akm is working correctly with the new layout, offer to help remove the legacy files:

Old locations to clean up (only after confirming new files exist and akm works):
- `~/.cache/akm/index.db`
- `~/.cache/akm/workflow.db`
- `~/.cache/akm/events.jsonl`
- `~/.cache/akm/tasks/history/`
- `~/.cache/akm/config-backups/`
- `~/.config/akm/akm.lock`

**Do not delete these files automatically.** Show the user the list and ask them to confirm before running any `rm` commands. Run each deletion separately so the user can verify one at a time.

## Troubleshooting

- **"source not found" for all steps**: The user may not have run akm before, or their data may already be in the new locations. This is expected for new installs.
- **"destination already exists" skips**: The data was already migrated. No action needed.
- **Failed step for events.jsonl**: Check that `src/core/state-db.ts` is present and `bun` can import it. This step requires the akm source tree to be present.
- **Permission errors**: Check that the user has write access to `~/.local/share/` and `~/.local/state/`. On some systems these directories may not exist yet — `mkdir -p` as needed.
- **Size mismatch errors**: The filesystem may have run out of space during the copy. Check available space with `df -h` and try again.
