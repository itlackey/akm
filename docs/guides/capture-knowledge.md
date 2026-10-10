# Capture Knowledge

Insights don't have to evaporate at the end of a session. `akm remember`
captures a short observation or decision, `akm import` pulls an existing
document into your library, `akm bundle add` keeps an external directory or
repo connected on an ongoing basis, and an LLM wiki organizes captured
material into a maintained, cross-referenced knowledge base. Once written,
captured material is indexed like any other asset — the next agent to run
`akm curate` or `akm search`, regardless of which tool it is, can find it.
This is "one library for every agent" applied to what you and your agents
learn along the way, not just what you started with.

## Fast path

```sh
# Save a quick observation
akm remember "Hot-fix deploys skip staging; always notify on-call first" \
  --tag ops --tag deployment

# Pull an existing document into the library
akm import ./postmortem-2026-05.md --name postmortem-2026-05

# Confirm it's there
akm show knowledge/postmortem-2026-05
```

## How it works

`akm remember` writes a context fragment — an observation, decision,
snippet, or note — into `memories/` in your writable bundle. Pass a quoted
string for short notes, or pipe markdown via stdin for longer content.

```sh
akm remember "Deployment needs VPN access"
akm remember "Pair with ops before rotating prod secrets" --path ops --name prod-secrets

# Structured metadata:
akm remember "VPN required for staging deploys" \
  --tag ops --tag networking \
  --expires 90d \
  --source "skills/deploy"

# Heuristic tagging (zero-latency, pure TS):
akm remember "Found this snippet: curl -fsSL ... | bash" --tag ops --auto

# LLM-assisted enrichment (requires a configured LLM; fails soft):
cat long-meeting-notes.md | akm remember --name meeting-2026-05 --enrich

# Route to a named writable bundle:
akm remember "Use staging cluster for blue-green" --bundle team-bundle
```

`--xref` cites related assets in the memory's frontmatter, and `--supersedes`
writes a correction while demoting the stale asset it replaces in the same
step. Scope flags (`--user`, `--agent`, `--run`, `--channel`) partition
memories for multi-agent environments; a scoped memory is only returned when
the same scope filter is supplied to `akm search` or `akm show`. Full flag
reference, belief-state mechanics, and provenance detail live in
[Memory](../reference/memory.md).

`akm import` brings an existing document — a local file, a single URL, or
stdin — into `knowledge/` as a searchable reference asset. Unlike
`akm bundle add` (which registers a persistent source), `import` is a
one-shot capture: a URL import fetches only the exact page you pass, converts
it to markdown, and does not crawl linked pages or register a source.

```sh
akm import ./docs/auth-flow.md
akm import ./notes/release.txt --name release-checklist
akm import - --name scratch-notes < notes.md
akm import https://example.com/docs/auth

# Route to a named writable bundle:
akm import ./docs/auth-flow.md --bundle team-bundle
```

Both commands accept `--xref <ref>` to cross-reference related assets and
`--supersedes <ref>` to correct and demote an existing asset in one step —
refs are validated before anything is written, so a typo fails fast instead
of leaving a dangling reference. See [Memory](../reference/memory.md) for the
belief-state and provenance model these flags drive.

## Decision table

| Need | Use |
| --- | --- |
| Save a short observation, decision, or gotcha from the current session | `akm remember` |
| Copy one existing document into the writable library | `akm import` |
| Keep an external directory or repo connected on an ongoing basis | `akm bundle add` |
| Maintain a structured, agent-authored wiki with raw sources and cross-referenced pages | [Wikis](wikis.md) |

## How captured material becomes available to every agent

A memory or import is a normal asset the moment it's written: `akm index`
(run automatically by most write paths, or explicitly when needed) folds it
into the unified search database, and from then on any agent — Claude Code,
OpenCode, or any other shell-capable assistant pointed at the same bundle —
finds it through the same `akm search` / `akm curate` / `akm show` calls it
uses for scripts and skills. Nothing about the capture path is
tool-specific; the retrieval loop (connect, index, curate, show, use/run,
feedback, proposal) treats a `akm remember` note the same way it treats a
bundled skill.

## Common problems

**`akm remember` rejects the write with a tags-required error.** Passing
`--expires`, `--source`, or `--description` without any `--tag` triggers a
required-field check before anything is written. Either add at least one
`--tag`, or drop those flags and use the zero-flag form
(`akm remember "body"`), which writes bare with no frontmatter.

**A URL import didn't pick up the rest of the site.** That's expected — an
import fetches exactly the page you pass. To keep a whole site or repo in
sync on an ongoing basis, use `akm bundle add` instead.

**`--xref` or `--supersedes` fails with exit 2 before writing anything.**
The cited ref doesn't resolve in the write target or any configured source.
Fix the ref (check `akm search` for the correct one) and retry — validation
runs before the write, so nothing partial is left behind.

**A scoped memory isn't showing up in search.** Scoped memories
(`--user`/`--agent`/`--run`/`--channel`) only surface when the same scope
filter is passed to `akm search --filter` or `akm show --filter`.

## See also

- [Memory](../reference/memory.md) — belief state, corrections, and
  provenance detail for `remember` and `import`
- [Wikis](wikis.md) — the LLM-wiki bundle format for maintained, structured
  knowledge
- [Bundles](bundles.md) — connecting external directories and repos on an
  ongoing basis
- [Environment & Secrets](../reference/env-and-secrets.md) — protected
  configuration and credential storage, not plain knowledge capture
- [CLI Reference](../reference/cli.md) — full flag documentation for
  `remember` and `import`
