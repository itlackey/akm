Usage:
  akm improve
  akm improve <type>
  akm improve <ref>

Description:
  Analyze existing AKM assets and generate improvement proposals.

Modes:
  akm improve
      Improve all eligible assets in the current scope.

  akm improve <type>
      Improve all assets of a given type.
      Example: akm improve memory

  akm improve <ref>
      Improve one specific asset.
      Example: akm improve workflow:release-checklist

What it does:
  - reviews feedback and recent history
  - proposes edits to existing assets
  - distills lessons where useful
  - promotes durable skill lessons into skill reference-doc proposals when justified
  - cleans and consolidates memories
  - writes results to the proposal queue

Options:
  --task <text>        Add extra guidance for this improvement pass
  --dry-run            Show planned actions without generating proposals
  --target <source>    Override the write target for accepted proposals
  --auto-accept[=<value>]
                        Confidence threshold (0-100) for auto-accepting reflect/distill proposals.
                        --auto-accept            accept at threshold 90 (same as =90)
                        --auto-accept=<N>        integer 0-100; accept proposals at or above N
                        --auto-accept=safe       alias for 90 (back-compat, not deprecated)
                        --auto-accept=false      disable; proposals go to the queue for manual review
                        Default when flag is absent: reflect/distill proposals are NOT auto-accepted
                        (they go to the proposal queue). Consolidation proposals always auto-accept
                        at threshold 90 regardless of this flag; pass --auto-accept=false to
                        disable consolidation auto-accept too.
                        Note: until proposals carry real confidence scores, any non-`false`
                        value behaves like the legacy "safe" mode (whole-batch auto-accept).
  --profile <name>     Improve profile to apply. Built-ins: default, quick,
                        thorough, memory-focus. User-defined profiles under
                        `profiles.improve.<name>` in config are also accepted.
                        Profiles bundle process gating, type filters,
                        cooldown overrides, and run-level autoAccept/limit
                        defaults. Falls back to `defaults.improve` in config,
                        then to "default". Unknown names fall back to default
                        with a warning.
  --ignore-cooldown    Disable reflect/distill/consolidate cooldown checks for this run
  --reflect-cooldown-days <n>
                        Override reflect cooldown with a non-negative integer
  --distill-cooldown-days <n>
                        Override distill cooldown with a non-negative integer
  --consolidate-cooldown-days <n>
                        Override consolidate cooldown with a non-negative integer
  --consolidate-recovery <mode>
                        Recovery mode for stale consolidate journals: abort (default) or clean
  --require-feedback-signal
                        Only process refs with recent feedback signal events
  --min-retrieval-count <n>
                        Retrieval fallback threshold when no recent feedback exists (default: 5)
  --json-to-stdout      Emit the full JSON result on stdout (legacy behaviour).
                        (0.8.0+: full JSON is written to .akm/runs/<run-id>/improve-result.json
                        and stdout is empty; use --json-to-stdout for the prior behaviour,
                        e.g. `akm improve --json-to-stdout | jq`.)

Examples:
  akm improve
  akm improve memory
  akm improve skill
  akm improve skill:code-review
  akm improve workflow:incident-response --task "reduce duplication"
  akm improve --profile quick
  akm improve --profile memory-focus
