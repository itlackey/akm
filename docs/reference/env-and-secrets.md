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
| Injects | many vars at once (`--env <ref>`) | one var (`--secret <ref>:<VAR>`) |

## Addressing: the akm ref

`env` and `secret` assets are addressed like every other asset, by their akm
ref `[bundle//]conceptId`: `env/prod`, `secrets/gitea_token`,
`team//secrets/discord_bot_token`. There is no bare-name form: `--env prod`
and `--secret gitea_token:TOKEN` are usage errors that name the full ref
(`env/<name>`, `secrets/<name>`). An unqualified ref resolves the
way every unqualified ref does: the default bundle first, then installation
priority.

## What each command prints

- `akm env list` and `akm show env/<name>` print key names only: no values and
  no comment text.
- `akm secret list` prints secret names only.
- `akm env path <ref>` prints the absolute path of the env file.
- `akm env export <ref> --out <file>` writes a sourceable `export KEY='value'`
  script to the file (mode 0600), single-quoting each value so shell
  substitutions in the source `.env` become literal strings. It requires
  `--out` and prints no values to stdout.
- Values reach a process through the `--env` and `--secret` flags of `akm exec`
  (any command) and `akm run` (an akm asset), which place them in the child
  process's environment.

```sh
akm env create env/prod                   # create an empty .env group
akm env create env/prod --from-file ./.env  # or ingest an existing .env

# akm does not manage individual keys; edit the whole file with your editor:
$EDITOR "$(akm env path env/prod --quiet)"

akm env list
akm show env/prod                         # key names only (see "Indexing" below)

# Inject the whole .env into a script asset's process:
akm run --env env/prod scripts/deploy.sh
akm run tasks/deploy --env env/prod       # the same, for a task
# Any other program: akm exec (Experimental; off until experimental.exec is true)
akm exec --env env/prod -- $SHELL         # interactive session with the env loaded

# Store a single credential as a secret:
printf '%s' "$TOKEN" | akm secret set secrets/deploy-token
akm run --secret secrets/deploy-token:GITHUB_TOKEN scripts/release.sh

# Write into a specific source instead of the working bundle:
akm secret set secrets/deploy-token --bundle team --from-file ./token
```

## The `${ref}` token

Wherever akm substitutes a reference into a string it hands to a process or a
provider, the token is `${[bundle//]conceptId}`:

- an env value: `DISCORD_BOT_TOKEN=${team//secrets/discord_bot_token}`;
- a git bundle's config `credential`: `"${secrets/gitea_token}"`.

Where the token may appear decides what it may name:

- **In an env value**, any asset ref substitutes. A `secrets/...` ref stands for
  the secret's value; any other asset ref (for example
  `${scripts/lab/fetch.sh}`) stands for the asset's absolute path.
- **In a git bundle's `credential`**, only a `secrets/...` ref is accepted. A `${...}`
  naming any other kind of asset is rejected when the config loads.

The ref is resolved with the one ref walk, so it may name any bundle and any
asset its owner holds. A `${...}` body is a ref when it leads with a native type
directory, qualified or not (`${secrets/x}`, `${scripts/run.sh}`,
`${team//secrets/x}`), or when it is bundle-qualified and that bundle is
installed (`${docs//tables/customers}`, whatever adapter owns it). `akm env
run` and a workflow unit's `env:` binding replace the tokens in an env file's
values; `env export` writes them verbatim. A `${...}` body that is not an akm
ref (`${HOME}`, `${PATH//:/ }`, and shell substitution such as `${v//-/_}`
unless a bundle named `v` is installed) is plain text: it is left untouched in an env
value, and in a git bundle's `credential` a `${NAME}` that is a valid variable name is
expanded from the process environment. A ref no bundle owns is an error and
nothing is injected. Each read records an `env_access` event. See
[Workflow Schema: Binding a secret to a unit](workflow-schema.md#binding-a-secret-to-a-unit).

The API keys of model connections and `embedding` are
not secrets-store references: they are a `$VAR` environment reference or an
entry of `credentials.json` stored for the endpoint, and a `${secrets/...}` in an `apiKey` is ignored
with a warning (see [Configuration: Credentials](configuration.md#credentials)).
The `secrets/` store is for the secrets your own agents, tasks and bundle
sources need.

A secret's value is its file content with surrounding whitespace trimmed. That
one read is used by `--secret`, env tokens, bundle credentials and the
website fetchers, so a hand-written file's trailing newline never lands in an
HTTP header.

`${secret:NAME}` was the old env-value spelling, meaning the secret `NAME` in the
env file's own bundle. akm still reads it that way, as `${<bundle>//secrets/NAME}`
with the bundle that owns the env file, and warns once naming the env ref. The
env file is bundle content and is not rewritten; write the full ref.

`secret://name` was the config spelling of the same thing. It is retired:
config still reads it as `${secrets/name}` and names the key once, and `akm
migrate apply` rewrites the file.

## Running commands

`akm exec` is Experimental and off by default; `akm config set experimental.exec
true` turns it on. `akm exec [--env <ref>]... [--secret <ref>:<VAR>]... -- <command>` runs the
command with the values added to its environment: one argument is a shell line,
several are a program and its arguments (see [CLI: exec](cli.md#exec)). It exits
with the command's status and is exempt from `--format`. `akm run <ref>` takes
the same two flags and runs an agent, command, task or workflow with them (see
[CLI: run](cli.md#run)).

- Both flags repeat. Env assets apply in the order given, then secrets over
  them; a later flag wins over an earlier one for the same variable. Nothing
  runs when a ref is missing or a `--secret` is not `<ref>:<VAR>`.
- `akm run` scrubs the secrets it injected from the output it captures (task
  logs, agent replies, the workflow journal). `akm exec` hands the command the
  terminal, so its output is not scrubbed.
- `akm env run <ref> -- <command>` and `akm secret run <ref> <VAR> -- <command>`
  are Deprecated and removed in 0.11: put the command in a script asset under
  `scripts/` and run it with `akm run --env <ref> scripts/<file>` or
  `akm run --secret <ref>:<VAR> scripts/<file>`. `env run --only` and `--except`
  have no `run` form: keep the variables a command needs in an env asset of their
  own.
- `--clean` starts the child with a minimal inherited environment (`PATH`,
  `HOME`, locale and terminal basics, and akm's own location variables
  `AKM_CONFIG_DIR`, `AKM_CONFIG_FILE`, `AKM_DATA_DIR`, `AKM_CACHE_DIR` and
  `AKM_STATE_DIR`) instead of the full parent environment; `--inherit NAME,NAME`
  adds parent variables back. `--inherit` alone starts the child clean with those
  variables. `akm run` takes `--clean` and `--inherit` the same way.
- A value in an env file may contain a `${ref}` token, which injection replaces
  (see [The `${ref}` token](#the-ref-token)).
- Injected values stay in the child's environment for its whole lifetime, so its
  own subprocesses can read them, and the child decides what it writes to
  stdout and stderr. For a long-lived process, point it at the secret file
  (`<bundle>/secrets/<name>`) directly instead.
- Installing a bundle is the trust decision: `--env`, `--secret` and
  workflow `env:` bindings inject what the bundle's files define, including
  keys such as `PATH` or `LD_PRELOAD`, from any bundle, with no warning, block
  or flag. `akm lint` still reports such keys (`dangerous-env-key`,
  non-blocking) so an author can review their own files.
- Each run records an `env_access` or `secret_access` event with the key or
  variable names.

## Secrets in a version 5 task

A [version 5 task](tasks.md#task-source-v5-experimental) starts each script and
`exec:` step in a clean environment, so a secret reaches only the steps it is
given to. An agent step runs your harness in akm's environment as it is, with
what the task, step and run name set over it, so what akm's own environment holds
is there too:

- A secret reaches a step through `secret:` or `--secret`, or through an env
  asset that binds it to a variable. A task file names a secret only by its ref,
  and only under `secret:`; a `${secrets/...}` in a command, a prompt, `args:` or
  an `env:` value is refused before anything runs. A secret is not an input: a
  task that needs one names it, and a caller cannot pass one in `args:`.
- Before a step's result enters the run's state, and so before a later prompt can
  contain it, akm replaces each secret value set for that run with `[REDACTED]`.
  It does the same for logs and for a failed step's reason. A secret value is
  what akm treats as one elsewhere: a secret's value, and the value, when it has
  8 characters or more, of a variable whose name has `KEY`, `APIKEY`, `TOKEN`,
  `SECRET`, `PASSWORD`, `PASSWD`, `PASS`, `PAT`, `CREDENTIAL`, `CREDENTIALS` or
  `AUTH` as one of its `_`-separated parts, or is `PGPASSWORD` or `MYSQL_PWD`.
- A credential kept under a plain name, such as a webhook address in
  `NOTIFY_URL`, is not protected. Store it as a secret and give it with
  `secret:`.
- An agent that has a secret in its environment can print it with a command and
  read it; akm cannot prevent that. Give a secret to the step that needs it, not
  to the whole task or run.
- akm removes secret values from results and logs, not from files. A script that
  has a secret can write it into a file in the working folder, and an agent step
  that reads the file sees it.
- A bundle keeps its secrets and env assets as files. An agent that works in a
  bundle can open them, and what it reads that way is not removed from its
  reply. A run does not work in a bundle unless `cwd:` or `--cwd` names it.

## Files and storage

Env files live under `env/` and secrets under `secrets/` in the target bundle,
with mode 0600. A secret is written under an exclusive per-secret lock held in
akm's data directory. `akm secret set` reads the value from stdin by default,
or from `--from-file` (byte-exact, multi-line allowed) or `--from-env <VAR>`,
so the value is not on the command line. `akm env create --sensitive` adds a
sibling `.sensitive` marker; an env file or secret with that marker is left
out of `list` output and the search index, and `run` still works on it.

An env file or secret may be a symlink to a file anywhere else, such as a
container's `/run/secrets/<name>`: `akm env`, `akm secret`, `${secrets/name}`
substitution and a workflow `env:` binding follow it. A name still cannot climb
out of `env/` or `secrets/` with `..` or an absolute path. Writes never follow
a symlink out of the bundle.

### Indexing

`akm bundle create` makes the bundle a git repository and adds `env/` and
`secrets/` lines to its `.gitignore` when the file mentions neither, so those
files are not committed; akm's own commits follow git and apply no further
filter. `akm lint` reports an `env/` or `secrets/` file that git tracks in a
bundle with a remote as `tracked-secrets`; a bundle that versions them on
purpose lists `"tracked-secrets": ["**"]` under `lint.skip` in its config
entry. The indexer skips git-ignored files everywhere else, but it still
indexes the files under a bundle's `env/` and `secrets/` directories when git
ignores them: `akm search
--type env` and `akm show env/<name>` find an env file of a default bundle after
`akm index`. The index holds key names only for an env file and the name for a
secret; values are never indexed. `env list`, `env path`, `env export`,
`secret list`, `akm exec` and `akm run`'s `--env` and `--secret` read the files
directly and do not need the index.

## Write-target resolution

Env and secret mutations (`env create`, `env remove`, `secret set`, `secret remove`) choose their
destination like every other write command: an explicit `--bundle <source>`,
else `defaultWriteTarget`, else the working bundle. The chosen source must be
writable, or the command fails with a `ConfigError` before anything is written;
a git-backed writable target commits the mutation at a single operation
boundary. Reads (`list`, `show`, `path`, `run`, `export`) span all configured
sources.

## Stability

`env list`, `env path`, `env export` and `secret list` are Stable. `akm exec` is
Experimental and off until `experimental.exec` is true. `env run` and `secret run` are Deprecated. `env create`, `env remove`, `secret set` and `secret remove` are Experimental. See
[STABILITY.md](../../STABILITY.md).

## See also

- [Capture Knowledge](../guides/capture-knowledge.md): `remember`, `import`, and
  when to reach for each
- [CLI Reference](cli.md): the `env` and `secret` commands
