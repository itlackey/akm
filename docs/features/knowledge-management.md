# Knowledge Management

akm treats your hard-won insights as first-class assets. Discoveries captured
during a session, incident reports, research papers, and team runbooks are all
indexed alongside scripts and skills, so future agents can find and use them.
Four surfaces cover the full capture-and-organize lifecycle.

## akm remember

`akm remember` writes a context fragment — an observation, decision, snippet,
or note — into the `memories/` directory of your writable stash. Pass a quoted
string for short notes, or pipe markdown via stdin for longer content.

```sh
akm remember "Deployment needs VPN access"
akm remember "Pair with ops before rotating prod secrets" --name ops/prod-secrets

# With structured metadata:
akm remember "VPN required for staging deploys" \
  --tag ops --tag networking \
  --expires 90d \
  --source "skill:deploy"

# Heuristic tagging (zero-latency, pure TS):
akm remember "Found this snippet: curl -fsSL ... | bash" --auto

# LLM-assisted enrichment (requires configured LLM; fails soft):
cat long-meeting-notes.md | akm remember --name meeting-2026-05 --enrich

# Route to a named writable stash:
akm remember "Use staging cluster for blue-green" --target team-stash

# Save into a wiki instead of memories/:
akm remember "Auth service uses mTLS on port 8443" --wiki architecture
```

Memories support scope flags (`--user`, `--agent`, `--run`, `--channel`) for
multi-agent environments. Scoped memories are only returned when the same
scope filter is supplied to `akm search` or `akm show`.

**Example: save a deployment gotcha**

```sh
akm remember "Hot-fix deploys skip staging; always notify on-call first" \
  --tag ops --tag deployment
```

## akm import

`akm import` brings an existing document — a local file, a single URL, or
stdin — into `knowledge/` as a searchable reference asset. Unlike `akm add`
(which registers a persistent source), `import` is a one-shot capture.

```sh
akm import ./docs/auth-flow.md
akm import ./notes/release.txt --name release-checklist
akm import - --name scratch-notes < notes.md
akm import https://example.com/docs/auth

# Route to a named writable stash:
akm import ./docs/auth-flow.md --target team-stash

# Save into a wiki's raw/ directory:
akm import ./incident-report.md --wiki ops
akm import https://arxiv.org/abs/2404.01744 --wiki research
```

URL imports fetch only the exact page you pass; they do not crawl linked
pages or register a persistent source. The knowledge asset name defaults to
the filename or URL path.

**Example: import an incident report**

```sh
akm import ./postmortem-2026-05.md --name postmortem-2026-05
akm show knowledge:postmortem-2026-05
```

## akm wiki

`akm wiki` provides multi-wiki knowledge bases following the Karpathy LLM-wiki
pattern: raw immutable sources live in `raw/`, an AI agent writes synthesized
pages alongside them, and a `schema.md` rulebook keeps voice and structure
consistent across sessions. akm surfaces paths and invariants; your agent does
the actual writing.

```sh
# Lifecycle
akm wiki create research
akm wiki list
akm wiki show research
akm wiki remove research -y

# Add raw source material
akm wiki stash research ./paper.md
akm wiki stash research https://arxiv.org/abs/2404.01744
echo "# Notes" | akm wiki stash research - --as my-notes

# Navigate and maintain
akm wiki pages research
akm wiki search research "attention mechanism"
akm wiki lint research       # structural checks: orphans, broken xrefs, stale index
akm wiki ingest research     # dispatch defaults.engine to run the ingest workflow
```

Three layers: **raw sources** (`raw/`) that you never edit after stashing,
**wiki pages** that your agent writes using its native file tools, and a
**schema** (`schema.md`) you define to set the voice and conventions.
`akm index` regenerates each wiki's `index.md` as a side effect.

**Example: build a research wiki from arxiv papers**

```sh
akm wiki create ml-research
akm wiki stash ml-research https://arxiv.org/abs/1706.03762 --as attention
akm wiki ingest ml-research   # agent runs the ingest workflow and writes the pages
akm index
akm wiki lint ml-research
```

## akm env / akm secret

`akm env` manages `.env`-backed groups of configuration (a `.env` file loaded
wholesale), and `akm secret` manages a single standalone sensitive value. The
core security guarantee: **values never appear in akm's structured output**.
Only key names are shown — comment text is never surfaced either, since
comments can contain commented-out credentials. Values reach processes through
`akm env run` / `akm secret run`, never through akm's JSON output. (The old
`akm vault` verb was removed in 0.9.0.)

```sh
akm env create prod                       # create an empty .env group
akm env create prod --from-file ./.env    # or ingest an existing .env

# akm no longer edits entries — edit the file with your own editor:
$EDITOR "$(akm env path env:prod --quiet)"

akm env list
akm show env:prod                         # key names only

# Inject the whole .env into a subprocess (never onto stdout):
akm env run env:prod -- ./deploy.sh
akm env run env:prod -- $SHELL            # interactive session with the env loaded

# Store a single credential as a secret:
printf '%s' "$TOKEN" | akm secret set secret:deploy-token
akm secret run secret:deploy-token GITHUB_TOKEN -- gh release create v1.0.0
```

`.env` and secret files are stored at mode 0600 under `env/` in your stash.
Values **never cross argv** (no `/proc/cmdline` exposure) and never appear in
akm's structured output — only key names are shown.

**Example: store API endpoint config**

```sh
akm env create staging --from-file ./staging.env
akm env run env:staging -- ./smoke-test.sh
```

## Security model

### What akm protects

Values never cross argv (no `/proc/cmdline` exposure), never appear in akm's
structured output or search index, and env/secret files are stored at mode 0600.

### What akm does NOT protect

Values are **plaintext at rest** — protected only by filesystem permissions.
OS-level full-disk encryption (FileVault, LUKS, BitLocker) is the recommended
complement. env/secret files are excluded from `akm sync` git commits when
`env/` is listed in your stash `.gitignore`.

### Threat model scope

Suitable for developer workstation secrets (API keys, DB URLs). Not a
replacement for a dedicated secrets manager (HashiCorp Vault, AWS Secrets
Manager, 1Password Secrets Automation) in production infrastructure.

### Key-name hygiene

Key names are visible metadata — `akm env list` and `akm show env:<name>` show
them. Avoid encoding sensitive context in key names (e.g. prefer `DATABASE_URL`
over `PROD_POSTGRES_MASTER_PASSWORD`).

### Subprocess env residency

`akm env run` injects the whole `.env` into the child process environment for
its entire lifetime and they are visible to all subprocesses the child spawns.
Prefer a `secret` (or `akm secret run secret:<name> VAR -- cmd`) when the
command only needs one value. Avoid `env run` for long-lived daemon or server
processes.

### Rotation

Editing the `.env` overwrites the live file. If the stash is git-tracked, the
old value may remain in git history — use `git filter-repo` or BFG to purge if
a secret needs to be expunged from history.

## See also

- [Search & Discovery](search-discovery.md) — finding assets you have captured
- [Sources & Registries](sources-registries.md) — bringing in external knowledge at scale
- [Workflows](workflows.md) — structured procedures as a knowledge format
- [CLI Reference](../cli.md) — full flag documentation for `remember`, `import`, `wiki`, `env`, and `secret`
- [Wikis](../wikis.md) — detailed wiki lifecycle and ingest workflow
