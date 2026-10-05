# Improve the Library

AKM learns from outcomes, but changes remain reviewable. Every time an agent
uses a capability and reports back whether it helped, AKM folds that signal
into the asset's utility score; when the report says the content was wrong, it
proposes a concrete edit. Nothing lands in your bundle automatically: every
generated change queues as a proposal you (or an explicit policy) accept,
reject, or revert.

```text
agent selects capability -> agent records outcome -> AKM updates utility and analyzes evidence ->
AKM creates a proposal -> human or policy reviews the diff -> accept / reject / revert
```

## akm feedback

`akm feedback` records a positive or negative signal for any indexed asset.
The signal updates the asset's utility score immediately, so highly-rated
assets rank higher and underperformers surface less often right away. See
[Architecture: The Improvement Loop](../architecture/improvement.md#utility-scoring)
for how that score is computed.

`akm feedback <ref> --negative --reason "<what is wrong and what should change>"`
flags the asset: it ranks lower right away, and the next improve run may repair
its description, title or `when_to_use` from your reason. Improve does not
rewrite an asset's text. To correct a wrong fact there, attach the exact fix:
`--replace "<exact current text>" --with "<corrected text>" --source "<URL,
command or file that shows it>"` (repeat `--replace`/`--with` for several
edits). akm checks that each `--replace` text appears exactly once, records
nothing if one does not, and queues the edit as a `feedback` proposal for
review. `--positive` records that an asset helped (it raises its ranking) and
does not trigger a rewrite.

```sh
akm feedback skills/code-review --positive
akm feedback agents/reviewer --negative --reason "Gave outdated migration steps"
akm feedback knowledge/opencode-server --negative --reason "the default port is 4096, not 8000" --replace "port 8000" --with "port 4096" --source "https://opencode.ai/docs/server/"
akm feedback workflows/ship-release --positive --reason "Worked end-to-end on 0.8.0"

# With a structured reason slug (consumed by improve/distill prompts):
akm feedback skills/planner --negative --reason "incomplete-edge-cases"
```

Specify exactly one of `--positive` or `--negative`. The ref must be present in
the current local index. `--negative` additionally requires `--reason`, and
omitting it exits 2.
`--failure-mode` adds a curated taxonomy label but does **not** substitute for
`--reason`. Full flag reference:
[CLI Reference — feedback](../reference/cli.md#feedback---reason).

Record feedback about the asset's content: that it helped, or that it turned
out wrong, stale or unhelpful. A failed `akm` command, such as an `akm show`
that errors on the ref, says nothing about the asset, so don't record it as
feedback on it: reflect and distill read each reason as a report about the
asset's content.

**Example: flag a skill that gave bad advice**

```sh
akm feedback skills/deploy --negative \
  --reason "Skips the dry-run step; caused prod incident 2026-05-10" \
  --failure-mode dangerous
```

## akm log

`akm log` is the realtime append-only event stream that every mutating CLI
verb writes to — the record of what agents selected and what feedback they
gave.

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
feedback signals and usage patterns, then generates proposals — it never
writes directly to your bundle. By default, generated proposals always queue
for review; the underlying autonomy gate and strategy configuration are
covered in [Architecture: The Improvement Loop](../architecture/improvement.md).

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
`--dry-run` previews the bundle a live run would improve.

A rewrite (reflect) is planned only for assets with negative feedback in the
last 30 days that is newer than the last time improve tried them, or for an
explicit ref; a positive or note-only signal never plans one. Distill reads any
feedback on a memory in that window. Unless `--require-feedback-signal` is set,
two fallback lanes pick assets with no such feedback: high-salience assets that
were never reflected, and, in a strategy that enables proactive maintenance,
assets due for a revisit. They only select and score assets and plan nothing,
so improve does not rewrite on a proactive cadence. The planned assets are
ranked by salience and cut to `--limit`.
Improve reworks only what gets read: without fresh feedback, a fallback lane
picks an asset (and a memory is judged for consolidation) only if `search`,
`curate` or `show` returned it, or feedback named it, in the last 90 days — the
usage log's retention — or if it is new material no improve stage has processed
yet. An explicit ref (`akm improve skills/code-review`) is always reworked.
Full flag reference: [CLI Reference — improve](../reference/cli.md#improve).

`--dry-run` is an execution-plan preview, not a raw scope listing. Its
`plannedRefs` are the final ranked refs after validation, retrieval, signal,
disk, and limit gates. The accompanying `plan` keeps the pre-gate `rawInScope` count,
per-gate removal counts and reasons, configured versus effective limits, and
the selection lane for each final ref. `plan.snapshot` explains whether the
existing index was readable; a missing or incompatible index produces an
explicit empty snapshot without creating or migrating it. The plan reports the
cap as `limits.effective` (`limits.additiveReplayAllowance` is always `0` and
`limits.totalCeiling` equals the cap, because the replay lane is retired). It
also reports proactive-maintenance due statistics, consolidation pool gates and
chunk estimate, extract/memory-inference stage decisions, and proposal-triage
mode and caps. The plan has
`mode: "estimate"` and `dispatch: false`; producing it does not acquire the
improve lock, invoke an LLM, create state, or write proposals, events, assets,
cache files, or result records.

The preview is a best-effort observation assembled during the invocation, not
an atomic cross-store snapshot or a reservation. A later live run re-inspects
mutable index, state, filesystem, and session-log inputs before dispatch, so
concurrent changes can legitimately produce a different plan.

**Example: auto-generate lessons from usage patterns**

```sh
akm improve --dry-run        # preview what would be processed
akm improve --limit 20       # process at most 20 refs
akm proposal list            # review what was generated
```

## akm proposal (list, show, diff, accept, reject, reopen, revert)

`akm proposal list` lists pending proposals in the queue. Each proposal is an
AI-generated suggested change — an edit to an existing asset, a new lesson, a
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
akm proposal accept skills/akm-dream --target team-bundle
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

## akm proposal new

`akm proposal new` asks an engine to author a brand-new asset — useful
when you want to create something from scratch rather than improving an
existing asset. Any engine kind works (an LLM engine, an agent CLI or
`opencode-sdk`): the engine returns the asset as JSON, which akm validates.
Output always goes to the proposal queue, never directly to the bundle.

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
  --reason "Skips the dry-run step; caused prod incident 2026-05-10" \
  --failure-mode dangerous

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

Nothing in this loop bypasses review by default: `akm improve` only ever
queues proposals, and promotion into the bundle happens through an explicit
`akm proposal accept` (or an explicit opt-in policy) — see
[Architecture: The Improvement Loop](../architecture/improvement.md) for the
autonomy gate that governs the few lanes that can act without one.

## See also

- [Discover & Load](discover-and-load.md) — finding and loading assets
- [Knowledge Management](knowledge-management.md) — capturing memories and docs
- [Agent Integration](use-with-any-agent.md) — wiring feedback into agent workflows
- [CLI Reference](../reference/cli.md) — full flag documentation for `feedback`, `log`, `improve`, `proposal`
- [Architecture: The Improvement Loop](../architecture/improvement.md) — utility scoring, strategies, autonomy gates, auto-sync, and session extraction
- [Concepts](../guides/concepts.md) — bundles, refs and the index
