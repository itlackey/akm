# Bundling akm

This is for anyone shipping `akm` inside their own product: a Docker image, a
plugin whose `node_modules` carries its own akm, or any other install a human
never runs `akm setup` inside. It says exactly what to call at boot and what
each call's JSON means — nothing about akm's internals you don't need.

## The contract

Three lines cover it:

1. **Pin** an exact `akm-cli` version and install it however you install
   things (npm, the standalone binary, a `node_modules` dependency).
2. **At boot, run `akm migrate apply`** (or `akm upgrade`, which runs it).
   It is offline, idempotent, needs no root, takes its own safety copies,
   prints one JSON plan, and exits `0` unless a file is genuinely blocked.
3. **Read `akm health --format json`.** Never grep error text — akm's
   wording is not a stable interface; the JSON fields are.

Everything below is detail in service of those three lines.

## `akm migrate apply`

```sh
akm migrate status        # read-only: what would change
akm migrate apply --dry-run
akm migrate apply
```

In order, every run applies (or, under `status`/`--dry-run`, plans):

1. **config.json in its current shape** (`configFile`): retired and unknown
   keys dropped, legacy `extraParams` lifted onto first-class fields, the
   legacy `stashDir`/`sources[]`/`installed` layout converted to
   `bundles`/`defaultBundle`. Config loading already does all of this in
   memory; this persists it under a backup.
2. **Pending `state.db` migrations**, historical-destructive ones included
   (`stateMigrations`). This is the only path (besides `akm upgrade`, which
   calls the same code) that is allowed to apply a destructive migration to an
   existing, unversioned or behind-generation `state.db` — see
   [One-way state.db](#one-way-note-statedb-migrations-are-one-way) below.
3. **Task files**: every task file at version 2 or 3, and every version 4
   file still carrying the retired `schedule[].enabled` key, rewritten as
   task source v4 (`taskFiles`) under one backup directory per run. A file
   the planner cannot convert unambiguously is reported `blocked` and left
   alone; the rest still convert.
4. **Residue sweep**: superseded pre-0.9.0 `.akm` files in the stash and the
   transaction-journal, maintenance-barrier, lock-mutex and version-stamp
   files older releases kept under `$DATA`/`$STATE`/`$CONFIG` (`deadResidue`).

The step list in [`docs/reference/cli.md`](../reference/cli.md#migrate) is the
authoritative one; the two must agree.

### The plan JSON

One JSON object on stdout, always, with one field per step. A current
install, nothing to do, as `akm migrate status` prints it (under `apply` the
per-step objects carry results instead — `applied`, `removed` — with the
same step names):

```json
{
  "schemaVersion": 1,
  "status": "current",
  "blockers": [],
  "configFile": { "keys": [], "changed": false, "applied": false },
  "stateMigrations": { "pending": [] },
  "taskFiles": { "schemaVersion": 1, "changed": 0, "skipped": 0, "blocked": 0, "files": [] },
  "deadResidue": { "pending": [] }
}
```

`akm migrate status` against a tree with one blocked task file:

```json
{
  "schemaVersion": 1,
  "status": "blocked",
  "blockers": ["tasks/nightly.yml: with-on-non-command-target"],
  "stateMigrations": { "pending": [] },
  "taskFiles": {
    "schemaVersion": 1,
    "changed": 3,
    "skipped": 1,
    "blocked": 1,
    "files": [
      {
        "filePath": "tasks/nightly.yml",
        "status": "blocked",
        "reason": "with-on-non-command-target",
        "beforeHash": "…"
      }
    ]
  }
}
```

`status` is one of:

- **`current`** — no task-source file needs converting, and no config
  extraParams lift is pending. A no-op boot.
- **`ready`** — task sources have eligible changes and no config-lift
  conflict; a real `apply` will clear them.
- **`blocked`** — at least one item cannot be applied automatically (a
  genuine authoring problem, e.g. a task file the migrator can't rewrite
  unambiguously, or a config `extraParams` value that conflicts with its
  first-class field). `blockers` names each one. `apply` still applies
  everything it *can*, then reports `blocked` and exits non-zero.

A pending `state.db` migration needs no human decision, so it is never
`blocked`: under `akm migrate status` or `apply --dry-run` it reads as
`ready` (the run would change `state.db`) and is listed in
`stateMigrations.pending`; a real `apply` always applies it.

Key fields:

| Field | Meaning |
| --- | --- |
| `stateMigrations` | `{ pending: string[] }` under `status`/`--dry-run`; `{ applied: string[], safetyCopyPath?: string }` after a real `apply`. `safetyCopyPath` is present only when a historical-destructive migration ran — see below. |
| `taskFiles` | `changed`/`skipped`/`blocked` counts and a `files[]` array with each file's `status` and `reason`. |
| `backupPath` / `applied` | Present after a real apply that rewrote at least one task file: the run's backup directory and how many files it rewrote. |
| `deadResidue` | `{ pending: [...] }` under a read-only run, `{ removed: [...] }` / `{ recovered: [...], quarantined: [...], deferred: [...] }` after apply. An untrusted journal (unreadable `journal.json`, or a fence violation) is quarantined to `$DATA/txn-quarantine`; a trusted, fenced journal whose `rollback`/`finalize` throws is deferred, left in place under `$DATA/txn/<rootNs>/`. Neither is thrown, and neither sets `status` to `blocked`. `staleTxns.pending` entries carry `wouldQuarantine: { reason }` when the journal's read-only fence check alone (not a `rollback`/`finalize` run) already shows it would be quarantined by a real apply. |

**Backups and their retention:**

- Task-file backups go to `<dataDir>/backups/tasks/<timestamp>-<uuid>/`,
  one directory per apply run that rewrote a file; nothing prunes them.
- Config backups go to `<cacheDir>/config-backups/config-<ISO-ts>.json`,
  also capped at **5**.
- A `state.db` historical-destructive migration writes a verified sibling
  snapshot next to `state.db` itself:
  `state.db.pre-<migrationId>.<UTC-digits>.<UUID>.bak`. This one is **never
  auto-pruned** — it is a one-time, rare event (a single destructive ledger
  boundary), so clean it up yourself once you've confirmed the upgrade, if
  disk space matters to your image.

**Exit codes:**

| Exit | Meaning |
| --- | --- |
| `0` | `current` or `ready`-and-applied — nothing left to do. |
| `1` | `blocked` — at least one item needs a human. |
| anything else | A crash, not a migration outcome: `{"ok":false,"error":"...","code"?:"...","hint"?:"..."}` on stderr, with the exit code from akm's normal error-classification table (`2` usage, `70` internal, `78` config). |

**Idempotency:** re-running `apply` against a `current` database/tree is a
no-op — safe to put in every boot, every time, on every replica.

**Offline, no root:** every step reads and writes files/SQLite it already
owns under your configured `$DATA`/`$CACHE`/bundle directories. Nothing here
touches the network or needs elevated privileges.

## `akm upgrade` in a bundled install

```sh
akm upgrade              # install a newer release if there is one, then migrate
akm upgrade --check      # check for updates only — no install, no migration step
```

`akm upgrade` always runs the migration step after its install step — on
install success, on install failure, and when there was nothing to install.
Its result carries the same plan under `migration`:

```json
{
  "currentVersion": "0.9.8",
  "newVersion": "0.9.9",
  "upgraded": false,
  "installMethod": "package-local",
  "message": "akm runs as a dependency of the package at /opt/myapp; upgrade that package to move akm.",
  "migration": { "schemaVersion": 1, "status": "current", "blockers": [], "stateMigrations": { "pending": [] } }
}
```

**`installMethod: "package-local"`** is the detection that matters for a
bundler: an `akm` living inside *another* package's `node_modules` (your
image's `tools/` dependency, a plugin's own `node_modules/akm-cli`) is never
`npm install -g`'d over — that would silently diverge from the copy the
parent package actually executes. akm reports `upgraded: false` and names the
parent package to upgrade instead; **its migrations still run**, exactly as
in every other install method. `installMethod` is one of `"binary"`,
`"bun"`, `"npm"`, `"pnpm"`, `"package-local"`, or `"unknown"`.

**Exit code:** `akm upgrade` exits `1` when `migration.status` is `"blocked"`
or `"failed"`, even if the install itself succeeded — an upgrade whose
migration didn't finish is not done. This makes plain `akm upgrade` (no
flags) a safe, idempotent container entrypoint step on every boot: on an
already-current install with nothing pending it is a fast no-op that exits 0.

**`--check`** skips the migration step entirely — it only compares versions
and reports `updateAvailable`. Use it for a version-drift alert, not as your
boot check.

## `akm health`

```sh
akm health --format json
```

Read the JSON. Never parse the human-readable text or grep for a phrase —
that wording is not a stable interface.

**Exit codes:** `0` (`status: "pass"`), `4` (`status: "warn"`), `1`
(`status: "fail"`).

The check that replaces grepping akm's refusal text is a **hard check**
named `state-db-migrations`. Every `state.db` open applies pending migrations
(copying the file to `state.db.pre-<id>.bak` first when one drops schema), so
after an upgrade the check passes and names what health's own open applied:

```json
{
  "name": "state-db-migrations",
  "status": "pass",
  "message": "Applied 11 pending state.db migration(s) on open (018-drop-dead-lane-schema … 028-improve-ledger); the pre-migration copy is /data/akm/state.db.pre-018-drop-dead-lane-schema.bak.",
  "evidence": {
    "path": "/data/akm/state.db",
    "pending": [],
    "applied": ["018-drop-dead-lane-schema", "…", "028-improve-ledger"],
    "backupPath": "/data/akm/state.db.pre-018-drop-dead-lane-schema.bak"
  }
}
```

It is `fail` only when a pending migration could not be applied; `evidence.pending`
then names what is still pending. Watch this row's `status`, not error text.

## The `akm-migrate` executable

`akm-migrate` is the second `bin` entry the `akm-cli` npm package installs
(`akm` and `akm-migrate` side by side), and it is also embedded directly in
the compiled standalone binary — a release binary re-execs itself internally
to reach it, so it needs no separate download. Same surface either way:

```sh
akm-migrate status
akm-migrate apply --dry-run
akm-migrate apply
```

`akm migrate status`/`apply` (under the `akm` CLI) are a thin wrapper over
this same executable — same plan, same exit codes. Reach for `akm-migrate`
directly when you don't want `akm`'s `--format`/`--shape`/`--detail` output
handling in the way, e.g. a shell script that just wants the raw JSON line
on stdout and a plain exit code.

## Container entrypoint sketch

```sh
#!/bin/sh
set -e
akm --version                 # optional: confirm the pinned version actually landed
akm migrate apply             # offline, idempotent — exits 1 only if genuinely blocked
akm task sync --rebind        # only if you schedule akm tasks inside this image
akm health --format json      # read this JSON; act on ok/status, never on message text
```

### Environment variables

A bundler that controls the filesystem layout should set these explicitly
rather than rely on `$HOME`-derived defaults (names verified against
`src/core/paths.ts` and `src/tasks/scheduler-invocation.ts`):

| Variable | What it points at |
| --- | --- |
| `AKM_BUNDLE_DIR` | The content bundle (`$STASH`) — assets akm indexes and serves. |
| `AKM_CONFIG_DIR` | `config.json`'s directory. |
| `AKM_DATA_DIR` | Durable, non-regenerable data: **`index.db` and `state.db` live here.** This is the directory a migration snapshot's safety copy sits beside. |
| `AKM_CACHE_DIR` | Regenerable cache: registry downloads, config backups, task logs. Safe to discard between image builds (not between boots of the same running install). |
| `AKM_STATE_DIR` | **Not** where `state.db` lives, despite the name — this is the XDG "state" directory. Holds scheduled-task invocation context, companion-plugin hook state (Claude Code / OpenCode hook logs), and, per stash, `akm improve`'s machine-local writers (`improve/measurement/verdicts/`) and whole-run lock (`locks/`) — see [Storage locations](https://github.com/itlackey/akm/blob/main/docs/architecture/internals/storage-locations.md). Set it anyway if you schedule akm tasks inside the image, so that context is captured consistently rather than falling back to `$HOME/.local/state/akm`. |

Set all five to paths that persist across container restarts (a mounted
volume), or `akm migrate apply` will see an empty `state.db` on every boot
and never actually converge.

## One-way note: `state.db` migrations are one-way

Once a migration has run against `state.db`, an **older** akm binary that
later opens the same file refuses it outright — the migration ledger moved
forward, and there is no downgrade path. If you need the ability to roll
back a bundled akm version, take your own backup of the whole data directory
(`$AKM_DATA_DIR`) before running `akm upgrade`/`akm migrate apply` — the
per-migration safety copy described above exists to protect that one
destructive step, not as a general rollback mechanism for your deployment.
