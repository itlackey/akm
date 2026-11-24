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
the same two flags and runs a script, agent, command, task or workflow with them (see
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
with mode 0600. `akm secret set` reads the value from stdin by default,
or from `--from-file` (byte-exact, multi-line allowed) or `--from-env <VAR>`,
so the value is not on the command line. A `.sensitive` marker file left in a
bundle by an older release is ignored (it is not listed as a secret).

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

## Secrets kept by a secret manager

A bundle can be one keyring of the desktop's Secret Service (KWallet,
GNOME Keyring) or one Azure Key Vault, in place of a directory. Its config
entry names the keyring or vault in `location` and the adapter that reads it
in `adapter`:

```json
"bundles": {
  "keyring": { "adapter": "secret-tool", "location": "akm" },
  "vault": { "adapter": "azure-key-vault", "location": "team-vault" }
}
```

Every secret of the keyring or vault is a secret of the bundle, under
`secrets/<name>`, and is used as a secret kept as a file is:

```sh
akm index                                             # entries are indexed by name; values never are
akm secret list                                       # keyring//secrets/gh_token, vault//secrets/deploy-token, ...
akm show keyring//secrets/gh_token                    # name only
akm run --secret keyring//secrets/gh_token:GITHUB_TOKEN scripts/release.sh
printf '%s' "$TOKEN" | akm secret set keyring//secrets/npm_token
akm secret remove vault//secrets/deploy-token
```

Add one with `akm bundle add <location> --adapter <id> [--name <bundle>]`
(`akm bundle add akm --adapter secret-tool`), or write the config entry above. A
bundle's adapter and its address must fit: a store adapter needs `location` and
a directory adapter cannot have one, or `akm config set` refuses the change,
`akm doctor` reports the `bundle-adapters` check as failed, and the commands
that resolve the bundle fail naming it. `akm bundle list` reports `status.exists`
from the adapter: whether the keyring or vault is there.

A `${keyring//secrets/gh_token}` token in an env value or a git bundle's
`credential` reads it the same way, and an unqualified `secrets/<name>` reaches
such a bundle after the bundles before it in priority.

| | `secret-tool` | `azure-key-vault` |
| --- | --- | --- |
| `location` | the keyring's alias, else the keyring whose label it is, else the keyring at `/org/freedesktop/secrets/collection/<location>` | the vault's name |
| Needs | `secret-tool` (package `libsecret-tools`) and `busctl` (systemd), a running Secret Service, and the keyring to exist | the Azure CLI, signed in with `az login` |
| A secret's name | the entry's label | the vault's name for the secret: 1 to 127 letters, digits and `-` |
| Listed | every entry | every enabled secret that no Azure service manages |

- The metadata of a keyring or vault lives in the index, and akm keeps no
  secret on disk. `akm index` lists the store and records each secret's name;
  for a keyring entry it also records the entry's object path and the attribute
  pairs the keyring reports for it. At run time the only thing akm asks the
  store for is a value, by those recorded pairs: for a keyring one
  `SearchItems` (to confirm the entry is the only match) and one
  `secret-tool lookup`, for a vault one `az keyvault secret show` by name. A
  keyring that has since rewritten an entry's pairs (KWallet does when a wallet
  is reopened) is refused with `Keyring "<x>" no longer holds "<name>" as
  indexed: run akm index.` `akm secret set` and `akm secret remove` act on the
  recorded entry, and refresh its index row. A new keyring entry is stored with
  the single pair `akm <keyring>/<name>`, which `secret-tool store` requires and
  nothing else reads.
- A name that does not read back as the ref `secrets/<name>` (an empty label,
  one with a `#`, a backslash, a `.` or `..` path segment, a leading or trailing
  `/`, or trailing white space) is not listed, and `akm index` warns of it and
  `akm lint` reports it by ref (`invalid-name`). When more than one entry has a name, the one with the
  lowest object path wins (a vault has one secret per name). `akm index` warns of the others and `akm lint` reports them as
  `shadowed-spelling`, and reads, replaces and removes act on the winner. `akm
  lint` without `--dir` or a file reports these from the last `akm index` and
  never reaches the store; a store that was never indexed has no findings.
- A keyring or vault that `akm index` cannot list (unreachable, or locked and
  listing nothing) keeps the entries the index had; the index warns, naming
  it, and goes on. `akm secret list` reads a keyring's or vault's entries from
  the index, so it needs no unlock and never reaches the store. A
  command that needs it fails with `BUNDLE_UNREACHABLE`, naming the client and,
  when it is not installed, what provides it.
- Such a bundle is writable unless its entry sets `writable: false`. It takes
  secrets only: `akm secret set` and `akm secret remove` write it, and every
  other write command refuses it.
- **`secret-tool`**: `location` names the collection by its alias, else by its
  label, else by its object path `/org/freedesktop/secrets/collection/<location>`
  (how a collection was named before aliases). akm finds the collection once and
  uses its object path for every request. Every entry of the collection is listed,
  whoever stored it. `secret-tool` finds an entry by its attributes, so akm
  reads and replaces a value through the attributes the entry already has; an
  entry with no attributes is listed but cannot be read until it has one. A
  lookup is not limited to one collection: when an entry of another carries
  the same attributes, `secret-tool` may return that one. So before akm reads
  or replaces an entry it asks the Secret Service which entries those
  attributes find, and refuses, naming the other entry, unless the entry is the
  only one. An entry `akm secret set` creates carries the attribute `akm` with
  the value `<keyring>/<name>`. `secret-tool store` is given the collection's
  object path, so akm makes no alias. A client that does not answer within
  60 seconds fails the command with `BUNDLE_UNREACHABLE`.
  A locked keyring is unlocked by your keyring manager, not by akm: when akm
  reads, stores or deletes in it, `secret-tool` makes the manager show its own
  prompt and waits up to two minutes for the answer, and akm prints
  `Keyring "<x>" is locked: unlock it in the prompt your keyring manager shows.`
  to stderr first. Listing needs no unlock (it reads the index). Where a locked
  keyring lists no entries until it is unlocked (a closed KWallet), `akm index`
  warns, telling you to unlock it and run `akm index` again, and goes on; the
  entries the index had stay. KWallet may replace an entry's attributes when it is reopened;
  a read then says to run `akm index`, which records them again. On KWallet
  (`ksecretd`), a removal can be undone when the wallet is next loaded: the
  Secret Service stops listing the entry, but the wallet file may keep it, so
  check KWalletManager after a removal. An unanswered KWallet password dialog
  blocks every request to KWallet until it is answered or dismissed. The keyring must exist, and `secret-tool` cannot create it: create the wallet or
  keyring named in `location` in your keyring manager (KWalletManager,
  Seahorse). A missing one is refused naming the keyrings the service has. A
  process with no session bus (a scheduled task, a container) cannot reach the
  Secret Service.
- **`azure-key-vault`**: `akm secret set` passes the value to `az` in a
  temporary file only your user can read, removed when `az` returns. `akm
  secret remove` runs `az keyvault secret delete` and then `az keyvault secret
  purge`, so the secret is gone. If the vault refuses the purge (no purge
  permission, or purge protection), the remove still completes and akm says the
  vault keeps the deleted secret until its retention period ends; until then
  `akm secret set` of that name fails with a hint to recover or purge it. A
  purge that meets the delete still going is tried again, up to five times a
  second apart. A secret that is disabled, or that another Azure service
  manages, is not listed and not read. Reading one
  that was disabled after it was listed fails with that message, not as an
  unreachable vault. A secret name a vault cannot hold (not 1 to 127 letters, digits
  and `-`) is refused by `akm secret set` before `az` runs.
- `akm env` commands and the Desktop Files view apply to
  directory bundles; the Desktop protected-file view shows, edits, creates and
  deletes these secrets too.

### Unlocking a keyring, and unattended work

**Interactive use: keep akm's secrets in the wallet your login unlocks.** On
most desktops PAM unlocks one keyring when you log in: GNOME's `login` keyring
(`libpam-gnome-keyring`) and KWallet's `kdewallet` (`pam_kwallet5`, or
`ksecretd --pam-login`). It works only when that wallet's password is your
login password, and on KWallet only for a classic (blowfish) wallet, not a GPG
one. Point the bundle's `location` at that wallet, and reads need no prompt for
as long as you are logged in. A dedicated wallet is not unlocked at login: the
first read after it locks shows the keyring manager's own password prompt, and
someone has to answer it.

**What a keyring cannot do:** akm run without your desktop session (a
scheduled akm task, cron, a container, an SSH session) usually cannot reach
your session's D-Bus at all, so there is no keyring to talk to, locked or not.
Setting `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus` in that
environment reaches it only while you are logged in and the wallet is unlocked;
otherwise akm fails saying the keyring is locked or cannot be reached. Nobody
is there to answer a prompt, and an unanswered KWallet dialog blocks every
KWallet request until it is answered.

**For unattended work** (scheduled tasks, CI, containers, anything that runs
while you are logged out) **use file-based secrets** (a bundle's `env/` and
`secrets/` files) **or an Azure Key Vault bundle**, not a desktop keyring.
Keyring bundles are for interactive use.

## Write-target resolution

Env and secret mutations (`env create`, `env remove`, `secret set`, `secret remove`) choose their
destination like every other write command: an explicit `--bundle <source>`,
else `defaultWriteTarget`, else the working bundle. The chosen source must be
writable, or the command fails with a `ConfigError` before anything is written;
a git-backed writable target commits the mutation at a single operation
boundary. Reads (`list`, `show`, `path`, `run`, `export`) span all configured
sources.

## Stability

`env list`, `env path` and `secret list` are Stable. `env export` and `akm exec` are
Experimental and off until `experimental.exec` is true. `env run` and `secret run` are Deprecated. `env create`, `env remove`, `secret set` and `secret remove` are Experimental. Bundles kept by a secret manager are Experimental. See
[STABILITY.md](../../STABILITY.md).

## See also

- [Capture Knowledge](../guides/capture-knowledge.md): `remember`, `import`, and
  when to reach for each
- [CLI Reference](cli.md): the `env` and `secret` commands
