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
akm curate "deploy the app to staging"
# → shortlist; top item: {"type":"script","name":"deploy.sh","ref":"scripts/deploy.sh",
#                          "followUp":"akm show scripts/deploy.sh","reason":"..."}

akm show scripts/deploy.sh
# → {"run": "...", "setup": "...", ...} — ready to execute
```

That three-step arc — discover, load, and later record how it went — is the
whole retrieval loop this guide covers.

## 1. When to use search vs. curate

Reach for `akm search` when you already know roughly what you're looking for
— a type, a keyword, a conceptId prefix — and want a ranked list of matches.
Reach for `akm curate` when you're starting a task and want akm to do the
narrowing for you: curate runs a search and returns a small shortlist rather
than a long results page, with a reason and a follow-up command for each item.
In short: search when you know what you're querying for, curate when you know
what you're trying to do.

## 2. Discover a shortlist

`akm search` queries the unified index and ranks hits by relevance — keyword
(BM25) and semantic (vector) matches fused into one list:

```sh
akm search "deploy" --type script
# → {"hits":[{"type":"script","name":"deploy.sh","ref":"scripts/deploy.sh",
#             "action":"akm show scripts/deploy.sh -> ...","estimatedTokens":240}]}
```

`akm curate` goes further: it takes the top search hits in order, adds related
support refs, and includes a direct `akm show <ref>` follow-up on every result.
`--detail normal` also attaches a preview and run details to each item:

```sh
akm curate "review an architecture proposal" --type skill
# → shortlist with akm show skills/code-review as the top follow-up
```

At the default `--detail brief` both commands return a `ref` for every hit, which
is all an agent needs to call `akm show`. `--detail agent` adds each hit's `path`
and `editable` flag, for agents that read or edit the file directly. To list a
subtree instead of keyword-matching, end the query with a slash:
`akm search "knowledge/"` or `akm search "team//skills/"`. See
[CLI Reference](../reference/cli.md) for the full flag tables and exact
output-field lists per `--detail` level.

## 3. Load the selected capability

Once you have a ref, `akm show` loads its full content. Every asset type
returns type-specific fields — scripts include `run` and `setup`, skills
return `content`, workflows return parsed `steps`:

```sh
akm show scripts/deploy.sh
# → {"run": "...", "setup": "...", "cwd": "...", ...}
```

The ref format is `[bundle//]conceptId`. A short ref (no `bundle//`) resolves
against the default bundle first, then the other bundles in installation
order; the `bundle//` prefix names one bundle when the same conceptId exists
in several.

## 4. Load a document section

Knowledge docs and other markdown assets can be large. Read the outline first,
then only the sections you need. `--detail brief` returns the document's `toc`
without the body, and appending `#<slug>` to a ref returns one section:

```sh
akm show knowledge/api-guide --detail brief
# → {"toc": [{"level": 2, "text": "Authentication", "slug": "authentication", "startLine": 12}, ...], ...}
akm show knowledge/api-guide#authentication
# → just the "Authentication" section, not the full document
```

Every `slug` in `toc` selects its section, including repeated headings, which
get `-1`, `-2`, ... suffixes. A whole-document show carries the same `toc`
next to the body.

To get the document's opening context along with the section, add
`--context lead` and a budget:

```sh
akm show knowledge/api-guide#authentication --context lead --max-tokens 800
# → the document lead, then [Selected matching fragment] and the section
```

AKM keeps the selected section ahead of the lead when the budget is tight and
reports `contextTruncated` in JSON. The response also carries `selectedRef` (an
opaque `#akm-fragment-...` handle for that section), `parentRef`,
`previousRef` and `nextRef`, line bounds, and separate fragment and parent size
estimates.

An unmatched fragment is an error that lists the available slugs, so a guess
that misses still tells you what to try next; `--detail brief` is the way to
see them without guessing.

## 5. Record the outcome

After acting on a loaded asset, close the loop with `akm feedback` so the
improvement pipeline learns from the outcome:

```sh
akm feedback scripts/deploy.sh --positive
akm feedback skills/code-review --negative --reason "references a removed flag"
```

Record `--negative` only when the asset's content is wrong or stale, and say what
is wrong and what it should say. A note that simply did not fit your task is not
negative feedback: record nothing for it.
`akm feedback <ref> --negative --reason "<what is wrong and what should change>"`
flags the asset: it ranks lower right away, and the next `akm improve` run may
repair its description, title or `when_to_use` from your reason. Improve does
not rewrite an asset's text, so once you have verified the correct fact, attach
the exact fix: `--replace "<exact current text>" --with "<corrected text>"
--source "<URL, command or file that shows it>"`. That is how a one-off task
turns into a durable improvement to the shared library rather than a result
nobody else benefits from. `--positive` records that an asset helped (it raises
its ranking) and does not trigger a rewrite.

## 6. Troubleshoot an empty or poor result

- **Zero hits on an exact-sounding query** — keyword search matches any of the
  query's words (common English words are ignored), so a true zero usually
  means none of them is indexed yet. Run `akm index` (or `akm index --full`
  after adding a new source) and search again.
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

- [CLI Reference](../reference/cli.md) — full `--detail` flag
  semantics, complete flag tables, and exact output-field lists for `search`,
  `curate`, `show`, and `index`
- [Architecture](../architecture/architecture.md) — ranking and search
  implementation detail (Search Pipeline, Show Resolution, Utility Scoring)
- [Bundles](bundles.md) — where indexed assets come from
- [Capture Knowledge](capture-knowledge.md) — capturing and importing
  assets before they're discoverable
- [Use akm with any agent](use-with-any-agent.md) — how agents reference
  assets by ref in practice
- [Concepts](concepts.md) — bundles, refs, and the local index
