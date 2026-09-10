# Discover and Load

Load only what the current task needs. Agents rarely know the exact name of
the asset they need, and front-loading every skill, script, and doc into the
prompt wastes context on capability the task will never touch. akm keeps the
full library indexed and searchable, then lets an agent pull a shortlist,
inspect one candidate, and load exactly the ref (or document section) the
task requires — nothing more.

## End-to-end example

An agent picks up the task "deploy the app to staging." It doesn't know
whether a script, a workflow, or a skill covers this, so it starts broad,
narrows to a ref, and loads that ref's content:

```sh
akm curate "deploy the app to staging" --shape agent
# → ranked shortlist; top hit: {"type":"script","ref":"scripts/deploy.sh","score":0.91,...}

akm show scripts/deploy.sh
# → {"run": "...", "setup": "...", ...} — ready to execute
```

That three-step arc — discover, load, and later record how it went — is the
whole retrieval loop this guide covers.

## 1. When to use search vs. curate

Reach for `akm search` when you already know roughly what you're looking for
— a type, a keyword, a conceptId prefix — and want a ranked list of matches.
Reach for `akm curate` when you're starting a task and want akm to do the
narrowing for you: curate runs a search, attaches previews and follow-up
commands, and returns a small, high-confidence shortlist rather than a long
results page. In short: search when you know what you're querying for,
curate when you know what you're trying to do.

## 2. Discover a shortlist

`akm search` queries the unified index and ranks hits by relevance and
utility score:

```sh
akm search "deploy" --type script --shape agent
# → [{"type":"script","name":"deploy.sh","ref":"scripts/deploy.sh","score":0.87,...}]
```

`akm curate` goes further: it keeps search ranking as the backbone, applies
small type-aware nudges for close calls, falls back to token search when
phrase hits are weak, and can attach related support refs — all while
including a direct `akm show <ref>` follow-up on every result:

```sh
akm curate "review an architecture proposal" --type skill
# → ranked shortlist with akm show skills/code-review as the top follow-up
```

Use `--shape agent` on either command to get the `ref`/`path`/`editable`
fields an agent needs to act on a hit. See [CLI Reference](../reference/cli.md)
for the full flag tables and exact output-field lists per `--detail` level.

## 3. Load the selected capability

Once you have a ref, `akm show` loads its full content. Every asset type
returns type-specific fields — scripts include `run` and `setup`, skills
return `content`, workflows return parsed `steps`:

```sh
akm show scripts/deploy.sh
# → {"run": "...", "setup": "...", "cwd": "...", ...}
```

The ref format is `[bundle//]conceptId` — the `bundle//` prefix narrows
lookup to one installed bundle when a conceptId is ambiguous across bundles.

## 4. Load a document section

Knowledge docs and other markdown assets can be large. Append `#fragment` to
a ref to return one section by heading slug instead of the whole document:

```sh
akm show knowledge/api-guide#authentication
# → just the "Authentication" section, not the full document
```

Search can also return an opaque `#akm-fragment-...` selector for a bounded
piece of a long document. The exact selector remains the default. For memories
whose opening context helps interpret a later matching turn, opt into bounded
lead context:

```sh
akm show '<ref-from-search>' --context lead --max-tokens 800
# → indexed-safe document lead, then [Selected matching fragment] and the match
```

AKM preserves the selected match before lead bytes when the budget is tight and
reports `contextTruncated` in JSON. The response also distinguishes canonical
`parentRef` from `selectedRef` and includes fragment position, line bounds,
neighbors, and separate fragment/parent size estimates.

An unmatched fragment lists the available slugs instead of erroring, so a
guess that misses still tells you what to try next.

## 5. Record the outcome

After acting on a loaded asset, close the loop with `akm feedback` so ranking
and the improvement pipeline learn from the outcome:

```sh
akm feedback scripts/deploy.sh --positive
akm feedback skills/code-review --negative --failure-mode outdated --reason "references a removed flag"
```

Positive and negative feedback both feed `akm improve`'s proposal generation
— this is how a one-off task turns into a durable improvement to the shared
library rather than a result nobody else benefits from.

## 6. Troubleshoot an empty or poor result

- **Zero hits on an exact-sounding query** — the search pipeline already
  retries with prefix matching when the exact query returns nothing, so a
  true zero usually means the term genuinely isn't indexed yet. Run `akm
  index` (or `akm index --full` after adding a new source) and search again.
- **Query looks right but nothing comes back** — check `--type`: it's
  free-form and unvalidated, so a typo'd type (`scrpit` instead of `script`)
  silently returns no hits rather than erroring.
- **Local results are missing something you know exists** — confirm
  `--from` matches where the asset lives (`local` is the default; use
  `registry` or `all` to include the public registry).
- **A known-good asset doesn't show up** — session assets and
  `proposed`-quality entries are excluded from default results
  (`--include-sessions` / `--include-proposed` bring them back), and
  `--filter user=...`/`--filter agent=...` scoping can silently exclude
  entries that don't carry a matching scope.
- **Curate's shortlist feels off-topic** — narrow with `--type` to steer it
  toward workflows, skills, or scripts specifically, or fall back to `akm
  search` for a plain ranked list.

## 7. Reference links

- [CLI Reference](../reference/cli.md) — full `--detail`/`--shape` flag
  semantics, complete flag tables, and exact output-field lists for `search`,
  `curate`, `show`, and `index`
- [Architecture](../architecture/architecture.md) — ranking and search
  implementation detail (Search Pipeline, Show Resolution, Utility Scoring)
- [Bundles](bundles.md) — where indexed assets come from
- [Knowledge Management](knowledge-management.md) — capturing and importing
  assets before they're discoverable
- [Use akm with any agent](use-with-any-agent.md) — how agents reference
  assets by ref in practice
- [Concepts](concepts.md) — refs, search priority, and the FTS5 index
