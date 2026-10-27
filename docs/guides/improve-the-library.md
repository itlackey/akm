# Improve the Library

AKM learns from outcomes, but changes remain reviewable. When an agent reports
whether a capability helped, akm records the report; when the report says the
content was wrong, a later `akm improve` run drafts a concrete edit as a
proposal. A proposal changes your bundle when you accept it, or when a policy
you opted into does (see [Review-first](#review-first-and-the-autonomy-opt-in)).

```text
agent selects capability -> agent records outcome -> AKM updates utility and analyzes evidence ->
AKM creates a proposal -> human or policy reviews the diff -> accept / reject / revert
```

## akm feedback

`akm feedback` records a positive or negative signal for any indexed asset.
The signal changes the asset's search ranking immediately, so highly-rated
assets rank higher and assets flagged wrong or stale surface less often right
away, and it updates the asset's utility score, which improve and `akm metrics`
read. See
[Architecture: The Improvement Loop](../architecture/improvement.md#utility-scoring)
for how the score is computed.

`akm feedback <ref> --negative --reason "<what is wrong and what should change>"`
flags the asset: it ranks lower right away, and the next improve run may repair
its description, title or `when_to_use` from your reason. Improve does not
rewrite an asset's text. Once you have verified the correct fact, attach the
exact fix: `--replace "<exact current text>" --with "<corrected text>"
--source "<URL, command or file that shows it>"` (repeat `--replace`/`--with`
for several edits). akm checks that each `--replace` text appears exactly once,
records nothing if one does not, and applies the edit at once: no review, no
gate (the `feedback` proposal it files is accepted on the spot, so
`akm proposal revert` undoes it). `--positive` records that an asset helped (it raises its ranking)
and does not trigger a rewrite.

```sh
akm feedback skills/code-review --positive
akm feedback agents/reviewer --negative --reason "Gave outdated migration steps"
akm feedback knowledge/opencode-server --negative --reason "the default port is 4096, not 8000" --replace "port 8000" --with "port 4096" --source "https://opencode.ai/docs/server/"
akm feedback workflows/ship-release --positive --reason "Worked end-to-end on the first try"

# With a structured reason slug (consumed by improve/distill prompts):
akm feedback skills/planner --negative --reason "wrong-default-timeout"
```

Specify exactly one of `--positive` or `--negative`. The ref must be present in
the current local index. `--negative` additionally requires `--reason`, and
omitting it exits 2. Full flag reference:
[CLI Reference — feedback](../reference/cli.md#feedback).

Record feedback about the asset's content: that it helped, or that it turned
out wrong or stale. Record `--negative` only for content that is wrong or stale,
and say what is wrong and what it should say. A note that simply did not fit
your task is not negative feedback: record nothing for it. A failed `akm`
command, such as an `akm show` that errors on the ref, says nothing about the
asset, so don't record it as feedback on it: reflect and distill read each
reason as a report about the asset's content.

**Example: flag a skill that gave bad advice**

```sh
akm feedback skills/deploy --negative \
  --reason "Skips the dry-run step; caused prod incident 2026-05-10"
```

## akm log

`akm log` is the append-only event stream akm writes to as it works: what
agents selected, what feedback they gave, what improve and workflows did.

```sh
akm log                                         # All events, oldest first
akm log --type feedback                         # Filter by event type
akm log --ref skills/deploy
akm log --since '@offset:12345'                 # Resume from a durable cursor
```

See [CLI Reference — log](../reference/cli.md#log) for the full filter list
and cursor format.

## akm improve

`akm improve` is the main entry point for the self-improvement pass. It reads
feedback and usage, then generates proposals for you to review. Its model calls
run on your default connection, else your default harness (`--connection`,
`--harness` and `--model` choose another for a run; see
[Configuration](../reference/configuration.md#where-each-process-runs)). With
neither, `akm improve` skips each process that needs a model, says so, and points
at `akm setup`.

```sh
akm improve                           # Full bundle pass
akm improve memory                    # Scope to memory assets only
akm improve skills/code-review         # One asset
akm improve --task "reduce duplication"
akm improve --dry-run                 # Show planned refs without generating proposals
akm improve --limit 10                # Cap the refs the run processes
```

A run improves one bundle, the one it writes to (`--bundle`, else
`defaultWriteTarget`, else your working bundle), and leaves assets in your other
bundles alone even when they are writable. Run `akm improve --bundle team` to
improve another one. A scheduled run covers the same single bundle, so schedule
one `akm improve --bundle <name>` run per other bundle you want improved.

A rewrite (reflect) is planned for assets with negative feedback from the last
30 days that is newer than the last time improve tried them, or for an explicit
ref (`akm improve skills/code-review` always reworks that ref). A positive or
note-only signal never plans one, and neither does a negative whose exact fix
(`--replace`, `--outdated`, `--superseded-by`) has since been accepted. Unless
`--require-feedback-signal` is set, the proactive-maintenance lane (on in
`default`) also plans assets with no such feedback that are due for a revisit:
at most 15 per run (`processes.proactiveMaintenance.maxPerRun`), and only assets
not reflected or distilled for 30 days (`dueDays`), so each comes up at most
once a month. The lane only picks an asset that `search`, `curate` or `show`
returned (or feedback named) in the last 90 days, or new material no improve
stage has processed yet. The planned assets are ranked by salience and cut to
`--limit`. The full selection rules are in
[Improve Workflow](../architecture/internals/improve-workflow.md) and
[CLI Reference — improve](../reference/cli.md#improve).

`--dry-run` previews a run without calling an LLM or writing anything. The
result's `plannedRefs` are the refs left after every gate, and `plan` carries
the per-gate removal counts, the effective limit, and the connection or harness
and model each process would use. A live run re-inspects its inputs, so it can
plan differently.

**Example: auto-generate lessons from usage patterns**

```sh
akm improve --dry-run        # preview what would be processed
akm improve --limit 20       # process at most 20 refs
akm proposal list            # review what was generated
```

### Review-first, and the autonomy opt-in

`akm improve` queues proposals; it does not edit your assets. Three lanes that
would write without review stay off until you set `experimental.improveAutonomy`:

```sh
akm config set experimental.improveAutonomy true
```

- **Memory inference** writes `.derived.md` children next to memories.
- **Memory cleanup** rewrites belief-state frontmatter and moves retired
  memories to an archive.
- **Triage with `applyMode: "promote"`** (set in a strategy's `triage` block)
  accepts queued proposals whose quality judge passed, plus retire proposals
  the consolidate pair pass staged with no continuity risk.

With the key off (the default), each lane is downgraded and the downgrade is
reported on stderr and in `akm health`. `akm proposal drain --promote` is a
separate, explicit way to accept judged proposals and does not need the key.

Some writes happen either way: session summaries under `sessions/**`, the purge
at the start of each improve run of archived retired memories older than 30
days (git-tracked and clean ones only), the commit that `akm proposal accept`
makes in a git-backed bundle, and the end-of-run sync that commits and pushes a
git-backed bundle (`--no-sync` and `--no-push` turn it off for a run).

## akm proposal (list, show, diff, accept, reject, reopen, revert)

`akm proposal list` lists pending proposals in the queue. Each proposal is an
AI-generated suggested change: an edit to an existing asset, a new lesson, a
memory consolidation, or a deprecation. Review the diff, then accept or reject.

```sh
# List proposals
akm proposal list
akm proposal list --status pending
akm proposal list --ref skills/code-review

# Inspect a proposal
akm proposal show <id>
akm proposal diff <id>                          # Preview the change vs. the live asset

# Apply or discard
akm proposal accept <uuid-or-prefix>
akm proposal accept skills/akm-dream --bundle team-bundle
akm proposal reject <uuid-or-prefix> --reason "duplicates existing workflow"
```

Accepts full UUIDs, 8-character UUID prefixes, or asset refs. `akm proposal accept` runs
full validation before promoting the proposal into your bundle.
`akm proposal revert` restores the prior content of an accepted proposal from
its captured backup, and `akm proposal reopen <id>` undoes a rejection (it puts
a rejected proposal back to pending unless its target has changed since). Full
flag reference:
[CLI Reference — proposal](../reference/cli.md#proposal).

**Example: review and accept a memory consolidation**

```sh
akm proposal list --status pending
akm proposal diff abc12345             # preview the proposed consolidation
akm proposal accept abc12345           # write it to the bundle
```

### akm proposal drain

`akm proposal drain` works through the pending backlog in one pass: it rejects
empty diffs, accepts proposals whose quality judge passed on their exact content
when you pass `--promote` (add `--yes` outside a terminal), and leaves the rest
for you to review. Without `--promote` it stages and writes nothing to your
assets.

```sh
akm proposal drain --dry-run                    # List what would be accepted, rejected or deferred
akm proposal drain --promote --yes --max-accepts 10
```

## akm proposal new

`akm proposal new` asks an agent to author a brand-new asset, useful when you
want to create something from scratch rather than improving an existing asset.
It runs on your default harness, or on akm's own runtime over your connection
when you have no harness (`--harness` and `--connection` choose another): the
agent returns the asset as JSON, which akm validates. The result goes to the
proposal queue, not directly to the bundle.

```sh
akm proposal new skill code-review --task "PR-style review skill for TypeScript repos"
akm proposal new lesson docker-cleanup --file ./prompts/docker-cleanup.md
```

After the proposal is generated, review it with `akm proposal diff <id>` and apply with
`akm proposal accept`.

## End-to-end example: from bad experience to a reviewed fix

```sh
# 1. An agent hits a problem and records it
akm feedback skills/deploy --negative \
  --reason "Skips the dry-run step; caused prod incident 2026-05-10"

# 2. The event lands in the log immediately
akm log --ref skills/deploy --type feedback

# 3. A later improve pass reads the signal and drafts a fix
akm improve skills/deploy

# 4. The fix is a proposal, not a live edit — review it
akm proposal list --ref skills/deploy
akm proposal diff <id>

# 5. Accept, reject, or revert after acceptance if it doesn't hold up
akm proposal accept <id>
akm proposal reject <id> --reason "not the right fix"
akm proposal revert <id>
```

## See also

- [Discover & Load](discover-and-load.md) — finding and loading assets
- [Capture Knowledge](capture-knowledge.md) — capturing memories and docs
- [Agent Integration](use-with-any-agent.md) — wiring feedback into agent workflows
- [CLI Reference](../reference/cli.md) — full flag documentation for `feedback`, `log`, `improve`, `proposal`
- [Architecture: The Improvement Loop](../architecture/improvement.md) — utility scoring, strategies, autonomy gates, auto-sync, and session extraction
- [Concepts](concepts.md) — bundles, refs and the index
