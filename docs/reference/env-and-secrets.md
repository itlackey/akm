# Environment & Secrets

Reference for `akm env` and `akm secret` — the two protected-value asset
types. For task-oriented guidance on capturing knowledge in general, see
[Capture Knowledge](../guides/capture-knowledge.md); this page states exact
contract, defaults, and security behavior.

## env vs secret

`akm env` manages a `.env`-backed group of configuration (a whole `.env` file
loaded wholesale). `akm secret` manages a single standalone sensitive value —
one value per file, mirroring Docker's secret model. There is no `akm vault`
command; use `env` or `secret`.

| | `env` | `secret` |
| --- | --- | --- |
| Purpose | configuration — related settings for an app/service | authentication — one sensitive value |
| Holds | a `.env` file of many `KEY=value` pairs | one value per file |
| Discoverable | key *names* (not values) | name only (the whole file is the value) |
| Injects | many vars at once (`env run`) | one var (`secret run <ref> <VAR>`) |

## Addressing: the akm ref

`env` and `secret` assets are addressed like every other asset, by their akm
ref `[bundle//]conceptId`: `env/prod`, `secrets/gitea_token`,
`team//secrets/discord_bot_token`. There is no bare-name form. `akm secret
run gitea_token ...` and `akm env run prod -- ...` are usage errors that name
the full ref (`secrets/<name>`, `env/<name>`). An unqualified ref resolves the
way every unqualified ref does: the default bundle first, then installation
priority.

## Core security guarantee

Values never appear in akm's structured output. `env list` and `akm show
env/<name>` surface key names only — comment text is never surfaced either,
since comments routinely contain commented-out credentials and are treated
like values. `secret list` surfaces the secret's name only; the file content
is never shown. Values reach a process only through the safe injection
paths, `akm env run` and `akm secret run`, which pass values directly into
the child process — never through akm's own stdout, the index, or `akm
show`.

```sh
akm env create env/prod                   # create an empty .env group
akm env create env/prod --from-file ./.env  # or ingest an existing .env

# akm does not manage individual keys — edit the whole file with your own editor:
$EDITOR "$(akm env path env/prod --quiet)"

akm env list
akm show env/prod                         # key names only

# Inject the whole .env into a subprocess (never onto stdout):
akm env run env/prod -- ./deploy.sh
akm env run env/prod -- $SHELL            # interactive session with the env loaded
akm env run env/prod --only DATABASE_URL -- ./migrate

# Store a single credential as a secret:
printf '%s' "$TOKEN" | akm secret set secrets/deploy-token
akm secret run secrets/deploy-token GITHUB_TOKEN -- gh release create v1.0.0

# Write into a specific source instead of the working bundle:
akm secret set secrets/deploy-token --bundle team --from-file ./token
```

`env export --out <file>` writes a safe, sourceable `export KEY='value'`
script (re-serialised single-quoted, so shell substitutions in the source
`.env` become literal strings) — it requires `--out` and never prints values
to stdout.

## The `${ref}` token

Wherever akm substitutes a reference into a string it hands to a process or a
provider, the token is `${[bundle//]conceptId}`:

- an env value: `DISCORD_BOT_TOKEN=${team//secrets/discord_bot_token}`;
- a config credential (`engines.<name>.apiKey`, `embedding.apiKey`, a git
  bundle's `credential`): `"${secrets/openai}"`.

A `secrets/...` ref stands for the secret's value; any other asset ref (for
example `${scripts/lab/fetch.sh}`) stands for the asset's absolute path. The
ref is resolved with the one ref walk, so it may name any bundle. `akm env run`
and a workflow unit's `env:` binding replace the tokens in an env file's
values; `env export` writes them verbatim. A `${...}` body that is not an akm
ref (`${HOME}`, `${PATH//:/ }`) is plain text and is left untouched. A ref no
bundle owns is an error and nothing is injected. Each read records an
`env_access` event. See
[Workflow Schema: Binding a secret to a unit](workflow-schema.md#binding-a-secret-to-a-unit).

A secret's value is its file content with surrounding whitespace trimmed. That
one read is used by `akm secret run`, env tokens, config credentials and the
website fetchers, so a hand-written file's trailing newline never lands in an
HTTP header.

`${secret:NAME}` was the old env-value spelling, meaning the secret `NAME` in the
env file's own bundle. akm still reads it that way, as `${<bundle>//secrets/NAME}`
with the bundle that owns the env file, and warns once naming the env ref. The
env file is bundle content and is not rewritten; write the full ref.

`secret://name` was the config spelling of the same thing. It is retired:
config still reads it as `${secrets/name}` and names the key once, and `akm
migrate apply` rewrites the file.

## File modes and storage

`.env` files are stored at mode 0600 under `env/` in the target bundle;
standalone secrets are stored at mode 0600 under `secrets/`. A secret write
is atomic under an exclusive per-secret lock held in akm's data directory;
maximum secret size is 5 MB.
Values never cross argv (no `/proc/cmdline` exposure). An `env` file or
secret can carry a sibling `.sensitive` marker that excludes it from `list`
output and from the search index entirely; the value remains usable via
`run`.

An env file or secret may be a symlink to a file anywhere else, such as a
container's `/run/secrets/<name>`: `akm env`, `akm secret`, `${secrets/name}`
substitution and a workflow `env:` binding follow it. A name still cannot climb
out of `env/` or `secrets/` with `..` or an absolute path. Writes never follow
a symlink out of the bundle.

## Write-target resolution

Env/secret **mutations** (`env create`, `env remove`, `secret set`) choose
their write destination like every other write command: an explicit
`--bundle <source>` wins, else `defaultWriteTarget`, else the working
bundle. The chosen source must be writable — a non-writable target fails
with a `ConfigError` before anything is written — and a git-backed writable
target commits the mutation at a single operation boundary. Reads (`list`,
`show`, `path`, `run`, `export`) still span all configured sources.

## Subprocess residency

`akm env run` and `akm secret run` inject values directly into the child
process — never through a shell — but the child controls its own
stdout/stderr, so a command that prints its own environment will still leak
values into your terminal or agent transcript. Injected values live in the
child process environment for its entire lifetime and are visible to every
subprocess the child spawns.

- Prefer `akm secret run secrets/<name> <VAR> -- <command>` over `akm env
  run` when a command only needs one value.
- Avoid `env run` / `secret run` for long-lived daemon or server processes;
  for those, point the process at the secret file directly
  (`<bundle>/secrets/<name>`) so the value never sits in a process
  environment variable at all.
- Avoid running commands that print the environment (`env`, `printenv`,
  shell tracing, verbose diagnostics) in agent contexts unless you
  explicitly intend to expose the child environment.
- Installing a bundle is the trust decision: `env run`, `secret run` and
  workflow `env:` bindings inject what the bundle's files define, including
  keys such as `PATH` or `LD_PRELOAD`, from any bundle, with no warning, block
  or flag. `akm lint` still reports such keys (`dangerous-env-key`,
  non-blocking) so an author can review their own files.

## Stability

`env list`, `env path`, `env export`, `env run`, `secret list`, and `secret
run` — the read-and-inject surface — are Stable. `env create`, `env remove`,
and `secret set` — the write verbs — are Experimental. Check
[STABILITY.md](../../STABILITY.md) for the current tier of any command
before depending on its exact output shape.

## What this page does not cover

This page documents akm's own guarantees for these two asset types, not the
broader threat model (what a compromised bundle or malicious script could
still do, what filesystem-level exposure remains, how this compares to a
dedicated secrets manager). See [SECURITY.md](../../SECURITY.md) for that
fuller picture, including plaintext-at-rest scope and rotation guidance.

## See also

- [Capture Knowledge](../guides/capture-knowledge.md) — `remember`, `import`,
  and when to reach for each
- [CLI Reference](cli.md) — full flag documentation for `env` and `secret`
- [SECURITY.md](../../SECURITY.md) — full threat model
