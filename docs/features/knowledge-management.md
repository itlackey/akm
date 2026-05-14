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
akm wiki remove research --force

# Add raw source material
akm wiki stash research ./paper.md
akm wiki stash research https://arxiv.org/abs/2404.01744
echo "# Notes" | akm wiki stash research - --as my-notes

# Navigate and maintain
akm wiki pages research
akm wiki search research "attention mechanism"
akm wiki lint research       # structural checks: orphans, broken xrefs, stale index
akm wiki ingest research     # print the agent ingest workflow
```

Three layers: **raw sources** (`raw/`) that you never edit after stashing,
**wiki pages** that your agent writes using its native file tools, and a
**schema** (`schema.md`) you define to set the voice and conventions.
`akm index` regenerates each wiki's `index.md` as a side effect.

**Example: build a research wiki from arxiv papers**

```sh
akm wiki create ml-research
akm wiki stash ml-research https://arxiv.org/abs/1706.03762 --as attention
akm wiki ingest ml-research   # agent follows the printed workflow to write pages
akm index
akm wiki lint ml-research
```

## akm vault

`akm vault` manages `.env`-backed key/value stores for configuration and
secrets. The core security guarantee: **vault values never appear in akm's
structured output**. Only key names are shown. Values reach processes through
`source` or `vault run`, not through akm's JSON output.

```sh
akm vault create prod

# Values are read from stdin by default — never via argv
printf '%s' "$DB_URL"   | akm vault set vault:prod DATABASE_URL
printf '%s' "$API_KEY"  | akm vault set vault:prod API_KEY --comment "Rotate every 90 days"

# Or from an env var
AKM_VALUE="$TOKEN" akm vault set vault:prod TOKEN --from-env AKM_VALUE

akm vault list
akm vault path vault:prod

# Load in the current shell:
source "$(akm vault path vault:prod)"

# Inject into a subprocess:
akm vault run vault:prod -- env
akm vault run vault:prod/API_KEY -- printenv API_KEY
```

Vault files are stored at mode 0600 under `vaults/` in your stash. Values
**never cross argv** (no `/proc/cmdline` exposure) and never appear in akm's
structured output — only key names are shown.

**Example: store API endpoint config**

```sh
akm vault create staging
printf '%s' "https://api.staging.example.com" | akm vault set vault:staging API_BASE
printf '%s' "$AUTH_TOKEN" | akm vault set vault:staging AUTH_TOKEN --comment "Service account — rotate monthly"
source "$(akm vault path vault:staging)"
```

## See also

- [Search & Discovery](search-discovery.md) — finding assets you have captured
- [Sources & Registries](sources-registries.md) — bringing in external knowledge at scale
- [Workflows](workflows.md) — structured procedures as a knowledge format
- [CLI Reference](../cli.md) — full flag documentation for `remember`, `import`, `wiki`, `vault`
- [Wikis](../wikis.md) — detailed wiki lifecycle and ingest workflow
