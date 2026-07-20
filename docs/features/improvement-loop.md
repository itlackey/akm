# The Improvement Loop

akm does not require a perfect library on day one. It tracks which assets
agents actually use and what agents think of them, then generates improvement
proposals you can selectively apply. Over time the library adapts to your team's
real patterns — surfacing what works, flagging what doesn't, and consolidating
scattered memories into durable knowledge.

## akm feedback

`akm feedback` records a positive or negative signal for any indexed asset.
Feedback influences utility scores at the next index run, so highly-rated assets
rank higher and underperformers surface less often.

```sh
akm feedback skills/code-review --positive
akm feedback agents/reviewer --negative
akm feedback workflows/ship-release --positive --reason "Worked end-to-end on 0.8.0"
akm feedback skills/planner --negative --reason "Doesn't account for merge conflicts"

# With a structured reason slug (0.8.0+, consumed by improve/distill prompts):
akm feedback skills/planner --negative --reason "incomplete-edge-cases"
```

Specify exactly one of `--positive` or `--negative`. The ref must be present in
the current local index.

**Example: flag a skill that gave bad advice**

```sh
akm feedback skills/deploy --negative \
  --reason "Skips the dry-run step; caused prod incident 2026-05-10" \
  --reason "missing-safeguard"
```

## akm history / akm log

`akm history` gives a durable, per-asset audit trail of state changes — searches,
shows, and feedback events. `akm log` gives the realtime append-only stream
that every mutating CLI verb writes to.

```sh
# Per-asset audit trail
akm history                                     # Stash-wide, oldest first
akm history --ref skills/deploy                  # One asset
akm history --since 2026-05-01T00:00:00Z
akm history --format text                       # Human-readable

# Realtime event stream
akm log list                                    # All events
akm log list --type feedback                    # Filter by event type
akm log list --ref skills/deploy
akm log tail --format jsonl                     # Follow new events live
akm log tail --max-events 20
```

`akm log tail` supports `--since '@offset:<id>'` cursors so you can resume
from exactly where you left off across process boundaries without duplicates.

**Example: see what was used in the last week**

```sh
akm log list --since 7d --type select --format text
```

## akm improve

`akm improve` is the main entry point for the self-improvement pass. It reads
feedback signals and usage patterns, then runs reflect, distill, and
consolidate phases to generate proposals. It also refreshes graph extraction
and runs memory inference after consolidation.

```sh
akm improve                           # Full stash pass
akm improve memory                    # Scope to memory assets only
akm improve skills/code-review         # One asset
akm improve --task "reduce duplication"
akm improve --dry-run                 # Show planned refs without generating proposals
akm improve --limit 10                # Cap assets processed
akm improve --auto-accept=false       # Disable auto-accept (prompt on HTTP path)
akm improve --auto-accept=90          # Explicit threshold (also the default when flag is absent)
```

Selection defaults to assets with recent feedback signals first, with a
retrieval-count fallback for high-traffic assets that have no feedback yet.

**Example: auto-generate lessons from usage patterns**

```sh
akm improve --dry-run        # preview what would be processed
akm improve --limit 20       # run a bounded pass
akm proposal list            # review what was generated
```

**End-of-run auto-sync:** For git-backed stashes (detected by a `.git`
directory), `akm improve` automatically commits all changes as a single batch
at the end of the run — the same operation as `akm sync`. The `default` and
`thorough` strategies also push if the stash is writable. The `quick` and
`memory-focus` strategies skip sync entirely (lightweight passes should not
auto-commit). Use `--no-sync` to disable for any single run, or `--no-push`
to commit without pushing. Strategy sync behavior can be configured via the
`sync` block under `improve.strategies.<name>` in your config.

## akm proposal (list, show, diff, accept, reject, revert)

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
akm proposal accept skills/akm-dream --target team-stash
akm proposal reject <uuid-or-prefix> --reason "duplicates existing workflow"
```

Accepts full UUIDs, 8-character UUID prefixes, or asset refs. `akm proposal accept` runs
full validation before promoting the proposal into your stash.

**Example: review and accept a memory consolidation**

```sh
akm proposal list --status pending
akm proposal diff abc12345             # preview the proposed consolidation
akm proposal accept abc12345           # write it to the stash
```

## akm propose

`akm propose` authors a brand-new asset via the LLM pipeline — useful when you
want to create something from scratch rather than improving an existing asset.
Output always goes to the proposal queue, never directly to the stash.

```sh
akm propose skill code-review --task "PR-style review skill for TypeScript repos"
akm propose lesson docker-cleanup --file ./prompts/docker-cleanup.md
akm propose workflow release-checklist --task "Standard steps for shipping a release"
```

After the proposal is generated, review it with `akm proposal diff <id>` and apply with
`akm proposal accept`.

**Example: generate a new lesson from a prompt file**

```sh
akm propose lesson deployment-gotchas --file ./prompts/lessons-from-may-incidents.md
akm proposal list --status pending
akm proposal diff deployment-gotchas
akm proposal accept deployment-gotchas
```

## See also

- [Search & Discovery](search-discovery.md) — feedback improves ranking over time
- [Knowledge Management](knowledge-management.md) — capturing memories and docs
- [Agent Integration](agent-integration.md) — wiring feedback into agent workflows
- [CLI Reference](../cli.md) — full flag documentation for `feedback`, `history`, `events`, `improve`, `proposal`, `propose`
- [Concepts](../concepts.md) — how utility scores affect search ranking
