# AKM migration helper scripts

> **Status (0.9.0+): largely obsolete.** `index.db` no longer has a destructive
> "drop every table on a `DB_VERSION` mismatch" upgrade path, and AKM no longer
> writes pre-upgrade data-directory snapshots. Its schema is built by an
> idempotent baseline (`CREATE … IF NOT EXISTS` + guarded `ALTER`s + targeted
> migrations), so opening an older database converges it forward without
> dropping data. There is nothing to "scavenge" because nothing is clobbered.
>
> To recover a corrupt index, delete `index.db` and re-run `akm index` — every
> row is regenerable from your stash. The non-regenerable state (events,
> proposals, task history) lives in `state.db`, which evolves only through
> additive, never-drop migrations.
>
> The `v<N>-to-v<M>.ts` scripts here are retained only as historical, one-time
> helpers for the pre-0.9 destructive-upgrade era. New schema changes must be
> additive (see the migration-safety contract in
> `src/storage/engines/sqlite-migrations.ts`), so no new scavenge scripts are
> expected. This directory is a candidate for removal once no supported upgrade
> path still references it.

## Writing a schema change (the current model)

Add an entry to the relevant module's `MIGRATIONS` array (`state.db`,
`workflow.db`, or the `index.db` baseline in `src/indexer/db/db.ts`). Each
migration must be idempotent (`IF NOT EXISTS` / `INSERT OR IGNORE`), must not
DROP a table holding non-regenerable data, and must not rename or retype an
existing column — add columns with `ALTER TABLE … ADD COLUMN … DEFAULT …`. See
the contract in `src/storage/engines/sqlite-migrations.ts`.
