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
   prints one JSON plan, and exits `0` unless an item is genuinely blocked.
3. **Read `akm health --format json`.** Never grep error text — akm's
   wording is not a stable interface; the JSON fields are.

Everything below is detail in service of those three lines.

## `akm migrate apply`

```sh
akm migrate status        # read-only: what would change
akm migrate apply
```

In order, every run applies (or, under `status`, plans):

1. **config.json in its current shape** (`configFile`): unknown keys dropped,
   the 0.9 `configVersion` dropped, and the `engines` / `defaults` form converted to
   `connections` / `harnesses`. Config loading does not convert it (it warns
   and names this command); this writes the conversion under a backup. The API keys a config still holds in any
   form akm no longer reads move to `credentials.json` (`configFile.credentials`
   lists the entry names, never a value), and a leftover `models.json` is folded
   into the `models` of the connections and harnesses it names. A config older
   than 0.9.32 (the legacy `stashDir`/`sources[]`/`installed` layout) is not
   converted by 0.10: it blocks with a message to run
   `npm i -g akm-cli@0.9.32 && akm migrate apply && akm task sync` first. What each retired key becomes is the table in
   [Configuration](../reference/configuration.md#the-engines-form).
2. **Pending `state.db` migrations** (`stateMigrations`). Any command that opens
   `state.db` applies them; this step does it up front and reports what ran.
   0.10 adds none. A `state.db` from before the 0.9.32 floor (a ledger shorter
   than the 29 ids released through 0.9.32) is refused whole: the plan is
   `blocked` with the 0.9.32 recipe as its one blocker, and no other step runs.
   See [One-way state.db](#one-way-note-statedb-migrations-are-one-way) below.
3. **Asset `engine:` keys** (`assetEngineKeys`): the retired `engine:` key on
   commands, agents, workflows and task sources rewritten to `connection:` or
   `harness:` by what the name is now, under one backup directory per run. A
   bundle akm may not change is skipped.
4. **Content refs** (`assetContentRefs`): refs in the text files akm indexes in writable
   bundles that still use the old spelling (`knowledge/WORK/x`, now
   `WORK/x`), in frontmatter and body, rewritten under one backup directory per
   run. An old spelling that is now another file's ref is listed in `shadowed`
   and left as written. The same step re-keys the `state.db` rows (usage events,
   proposals, events, task history, improve ledger, asset salience and outcome)
   stored under an old spelling to the new one, `stateRows` of them; `index.db`
   is rebuilt by the next `akm index`.
5. **The OS scheduler** (`scheduler`): akm 0.10 keeps one scheduler entry that
   runs `akm task dispatch`; `apply` replaces akm 0.9's per-task rows with it
   in one write, the same as `akm task sync`. This is the only step that
   leaves akm's own files: it runs `crontab` (Linux), `launchctl` (macOS) or
   `schtasks` (Windows), and only when it has something to write. An install
   that moves a location (a config file other than the default, or an XDG variable, as an image
   does) never has its OS scheduler written: the plan says so in
   `scheduler.warnings`, and its supervisor runs `akm task dispatch`. A machine
   with no `crontab` binary gets a warning in `scheduler.warnings` and exit
   `0`; a `crontab` that exists and fails blocks.

A task source below version 4 that `scheduler.enabled` names blocks the plan
(it would silently stop running): 0.10 converts none, so `blockers` names the
file with the 0.9.32 recipe. One that is not enabled is a line in
`legacyTaskWarnings` and does not change the status.

### The plan JSON

One JSON object on stdout, always, with one field per step. A current
install, nothing to do, as `akm migrate status` prints it (under `apply` the
per-step objects carry results instead — `applied` — with the
same step names):

```json
{
  "schemaVersion": 1,
  "status": "current",
  "blockers": [],
  "configFile": { "keys": [], "changed": false, "applied": false },
  "stateMigrations": { "pending": [] },
  "assetEngineKeys": { "schemaVersion": 1, "changed": 0, "skipped": 0, "files": [] },
  "assetContentRefs": { "schemaVersion": 1, "changed": 0, "skipped": 0, "refs": 0, "files": [], "shadowed": [] },
  "scheduler": { "backend": "cron", "entry": "absent", "removedLegacy": [], "keptLegacy": [], "hasRemovals": false, "failures": [] }
}
```

`akm migrate status` against a `state.db` from before the floor:

```json
{
  "schemaVersion": 1,
  "status": "blocked",
  "blockers": ["This state.db predates akm 0.9.32 and this akm does not upgrade it: run the 0.9.32 recipe, then upgrade."]
}
```

`status` is one of:

- **`current`** — no asset needs rewriting, and no config rewrite is pending.
  A no-op boot.
- **`ready`** — assets or the config have eligible changes; a real `apply`
  will clear them.
- **`blocked`** — at least one item cannot be applied automatically (a
  `state.db` below the floor, a config that fails validation, or a step that
  failed). `blockers` names each one. `apply` still applies
  everything it *can*, then reports `blocked` and exits non-zero.

A pending `state.db` migration needs no human decision, so it is never
`blocked`: under `akm migrate status` it reads as
`ready` (the run would change `state.db`) and is listed in
`stateMigrations.pending`; a real `apply` always applies it.

Key fields:

| Field | Meaning |
| --- | --- |
| `stateMigrations` | `{ pending: string[] }` under `status`; `{ applied: string[] }` after a real `apply`. |
| `assetEngineKeys` | `changed`/`skipped` counts and a `files[]` array with each rewritten file's `rewrites` (`at`, `from`, `to`). |
| `assetContentRefs` | `changed`/`skipped` file counts, `refs` (old-spelling refs found), a `files[]` array with each file's `refs`, and `shadowed[]` (`bundleId`, `from`, `to`): old spellings another file holds as its ref, not rewritten; `stateRows`, the `state.db` rows keyed by an old spelling that move to the new one; and `reconcile[]`, present after an apply that rewrote files inside a git checkout: the checkout path and how to review, commit or restore the edits. Only asset files, `index.md` and wiki `schema.md` are rewritten. |
| `scheduler` | `backend`, `entry` (`installed`, `updated`, `unchanged`, `removed`, `absent` or `unmanaged`), `removedLegacy[]` (akm 0.9 per-task rows removed), `keptLegacy[]` (rows that name another installation), `warnings[]`. |

**Backups and their retention:**

- Asset backups go to `<dataDir>/backups/asset-engine-keys/` and
  `<dataDir>/backups/asset-content-refs/` (`<timestamp>-<uuid>/`), one directory
  per apply run that rewrote a file; nothing prunes them.
- Config backups go to `<cacheDir>/config-backups/config-<ISO-ts>.json`; akm
  keeps the newest **5** and prunes older ones.

**Exit codes:**

| Exit | Meaning |
| --- | --- |
| `0` | `current` or `ready`-and-applied — nothing left to do. |
| `1` | `blocked` — at least one item needs a human. |
| anything else | A crash, not a migration outcome: `{"ok":false,"error":"...","code"?:"...","hint"?:"..."}` on stderr, with the exit code from akm's normal error-classification table (`2` usage, `70` internal, `78` config). |

**Idempotency:** re-running `apply` against a `current` database/tree is a
no-op — safe to put in every boot, every time, on every replica.

**Offline, no root:** nothing here touches the network or needs elevated
privileges. Every step but `scheduler` reads and writes only files and SQLite
under your configured `$DATA`/`$CACHE`/bundle directories; `scheduler` runs the
OS scheduler's own command as the current user, and only on a default install.

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

After the install step it also updates the akm plugin of each agent harness
present in the image (Claude Code, Codex, OpenCode), reported under `plugins`;
see [`akm upgrade`](../reference/cli.md#upgrade) for the rules, the OpenCode
version lockstep and the Codex hook-trust entries a headless image needs.

**`--check`** skips the migration step entirely — it only compares versions
and reports `updateAvailable` (plus the pending per-harness plugin updates). Use it for a version-drift alert, not as your
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
so after an upgrade the check passes and names what health's own open applied:

```json
{
  "name": "state-db-migrations",
  "status": "pass",
  "message": "Applied 29 pending state.db migration(s) on open (001-initial-schema … 029-improve-ledger-content-hash).",
  "evidence": {
    "path": "/data/akm/state.db",
    "pending": [],
    "applied": ["001-initial-schema", "…", "029-improve-ledger-content-hash"]
  }
}
```

It is `fail` only when a pending migration could not be applied; `evidence.pending`
then names what is still pending. Watch this row's `status`, not error text.

## The `akm-migrate` executable

`akm migrate status`/`apply` spawn the migrator (`scripts/akm-migrate`) in the
`akm-cli` npm package, and a compiled standalone binary embeds it and re-execs
itself to reach it, so it needs no separate download. It is not a separate
`bin` entry: run it through `akm migrate`.

## Container entrypoint sketch

```sh
#!/bin/sh
set -e
akm --version                 # optional: confirm the pinned version actually landed
akm migrate apply             # offline, idempotent — exits 1 only if an item is genuinely blocked
# to schedule akm tasks inside this image, run `akm task dispatch` every minute from its supervisor (see the scheduling guide)
akm health --format json      # read this JSON; act on ok/status, never on message text
```

### Environment variables

A bundler that controls the filesystem layout should set `AKM_CONFIG_FILE` (or
pass `--config <file>`) and name the rest in that file, rather than rely on
`$HOME`-derived defaults. The old `AKM_*_DIR` location variables are retired; see [Retired location variables](../reference/configuration.md#retired-location-variables).

| Variable or key | What it points at |
| --- | --- |
| `defaultBundle` and `bundles.<id>.path` | The content bundle (`$STASH`) — assets akm indexes and serves. |
| `AKM_CONFIG_FILE` | The config file; `credentials.json` and the config lock sit beside it. |
| `paths.data` | Durable, non-regenerable data: **`index.db` and `state.db` live here.** This is the directory a migration snapshot's safety copy sits beside. |
| `paths.cache` | Regenerable cache: installed git, npm and website bundles, config backups, task logs. If it is discarded, `akm bundle update --all` restores the bundles. |
| `paths.state` | **Not** where `state.db` lives, despite the name — this is the XDG "state" directory. Holds, per bundle, `akm improve`'s whole-run lock (`locks/`) — see [Storage locations](../architecture/internals/storage-locations.md). Set it too, so those locks sit on the same persistent volume as the rest of akm's state rather than under `$HOME/.local/state/akm`. |

Set the file and its `paths` (and the bundle `path`) to paths that persist across container restarts (a mounted
volume), or `akm migrate apply` will see an empty `state.db` on every boot
and never actually converge.

## Cold starts: carrying embedding vectors (Experimental)

A host with no persistent disk starts with an empty index, and nearly all of a
cold start is embedding. To carry the vectors over: at a checkpoint on a host
with a built index, run `akm index --export-vectors vectors.db`; copy
`vectors.db` to the fresh host; there run `akm index --import-vectors vectors.db`.
The keyword index is rebuilt as usual, and each entry whose embedded text is
unchanged takes its vector from the file instead of the embedder. The file holds
hashes and vectors only, no document text or paths. A different embedding model
or edited content is simply a miss and is embedded normally; a missing or
unusable file warns and indexes normally.

## One-way note: `state.db` migrations are one-way

Once a migration has run against `state.db`, there is no downgrade path. An
**older** akm that later opens the same file continues with the schema it knows
and warns once that the database is newer; upgrade akm if its output looks
incomplete. If you need the ability to roll back a bundled akm version, take
your own backup of the whole data directory (`paths.data`) before running
`akm upgrade`/`akm migrate apply`.
