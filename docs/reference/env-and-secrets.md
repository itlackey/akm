# Environment & Secrets

Reference for `akm env` and `akm secret`, the two asset types for values that
should not be printed. For task-oriented guidance on capturing knowledge in
general, see [Capture Knowledge](../guides/capture-knowledge.md); this page
states the exact behavior and defaults.

## env vs secret

`akm env` manages a `.env`-backed group of configuration (a whole `.env` file
loaded wholesale). `akm secret` manages a single standalone sensitive value,
one value per file, mirroring Docker's secret model.

| | `env` | `secret` |
| --- | --- | --- |
| Purpose | configuration: related settings for an app or service | authentication: one sensitive value |
| Holds | a `.env` file of many `KEY=value` pairs | one value per file |
| Listed as | key *names* | name only |
| Injects | many vars at once (`env run`) | one var (`secret run <ref> <VAR>`) |

## What each command prints

- `akm env list` and `akm show env/<name>` print key names only: no values and
  no comment text.
- `akm secret list` prints secret names only.
- `akm env path <ref>` prints the absolute path of the env file.
- `akm env export <ref> --out <file>` writes a sourceable `export KEY='value'`
  script to the file (mode 0600), single-quoting each value so shell
  substitutions in the source `.env` become literal strings. It requires
  `--out` and prints no values to stdout.
- Values reach a process through `akm env run` and `akm secret run`, which
  place them in the child process's environment.

```sh
akm env create prod                       # create an empty .env group
akm env create prod --from-file ./.env    # or ingest an existing .env

# akm does not manage individual keys; edit the whole file with your editor:
$EDITOR "$(akm env path env/prod --quiet)"

akm env list
akm show env/prod                         # key names only (see "Indexing" below)

# Inject the whole .env into a subprocess:
akm env run env/prod -- ./deploy.sh
akm env run env/prod -- $SHELL            # interactive session with the env loaded
akm env run env/prod --only DATABASE_URL -- ./migrate

# Store a single credential as a secret:
printf '%s' "$TOKEN" | akm secret set secrets/deploy-token
akm secret run secrets/deploy-token GITHUB_TOKEN -- gh release create v1.0.0

# Write into a specific source instead of the working bundle:
akm secret set secrets/deploy-token --target team --from-file ./token
```

## Running commands

`akm env run <ref> -- <command>` and `akm secret run <ref> <VAR> -- <command>`
spawn the command directly (no shell) with the values added to its environment.
They exit with the command's status and are exempt from `--format`.

- `env run` takes `--only KEY,KEY` or `--except KEY,KEY` to choose which
  variables are injected.
- `--clean` starts the child with a minimal inherited environment (`PATH`,
  `HOME`, locale and terminal basics) instead of the full parent environment;
  `--inherit NAME,NAME` adds parent variables back (only with `--clean`).
- A value in an env file may contain `${secret:NAME}`, which `env run` replaces
  with the secret `NAME` from the same bundle.
- Injected values stay in the child's environment for its whole lifetime, so its
  own subprocesses can read them, and the child decides what it writes to
  stdout and stderr. For a long-lived process, point it at the secret file
  (`<bundle>/secrets/<name>`) directly instead.
- A process-hijacking variable such as `LD_PRELOAD` or `PATH` is checked on
  both commands: in an env file for `env run`, and as the `<VAR>` name for
  `secret run`. In the working bundle or a local filesystem bundle (your own
  files) akm warns on stderr and injects anyway. In a bundle installed from
  elsewhere (a git, website or npm bundle) both commands stop unless you pass
  `--allow-dangerous-env-keys` after reviewing the file. `EDITOR`, `VISUAL` and
  `PAGER` only warn.
- Each run records an `env_access` or `secret_access` event with the key or
  variable names.

## Files and storage

Env files live under `env/` and secrets under `secrets/` in the target bundle,
with mode 0600. A secret is written under an exclusive per-secret lock held in
akm's data directory. `akm secret set` reads the value from stdin by default,
or from `--from-file` (byte-exact, multi-line allowed) or `--from-env <VAR>`,
so the value is not on the command line. `akm env create --sensitive` adds a
sibling `.sensitive` marker that leaves the file out of `env list` and the
search index; `env run` still works on it.

### Indexing

`akm bundle create` makes the bundle a git repository whose `.gitignore` lists
`env/` and `secrets/`, so those files are never committed. The indexer skips
git-ignored files everywhere else, but it still indexes the files under a
bundle's `env/` and `secrets/` directories when git ignores them: `akm search
--type env` and `akm show env/<name>` find an env file of a default bundle after
`akm index`. The index holds key names only for an env file and the name for a
secret; values are never indexed. `env list`, `env path`, `env export`,
`env run`, `secret list` and `secret run` read the files directly and do not
need the index.

## Write-target resolution

Env and secret mutations (`env create`, `env remove`, `secret set`) choose their
destination like every other write command: an explicit `--target <source>`,
else `defaultWriteTarget`, else the working bundle. The chosen source must be
writable, or the command fails with a `ConfigError` before anything is written.
Reads (`list`, `show`, `path`, `run`, `export`) span all configured sources.

## Stability

`env list`, `env path`, `env export`, `env run`, `secret list` and `secret run`
are Stable. `env create`, `env remove` and `secret set` are Experimental. See
[STABILITY.md](../../STABILITY.md).

## See also

- [Capture Knowledge](../guides/capture-knowledge.md): `remember`, `import`, and
  when to reach for each
- [CLI Reference](cli.md): the `env` and `secret` commands
