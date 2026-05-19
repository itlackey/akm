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
                        Confidence threshold (0-100) for auto-accepting proposals.
                        Default when the flag is absent: ON at threshold 90.
                        --auto-accept            same as --auto-accept=90
                        --auto-accept=<N>        integer 0-100; accept proposals at or above N
                        --auto-accept=safe       alias for 90 (back-compat, not deprecated)
                        --auto-accept=false      disable auto-accept; HTTP consolidation path
                                                 will prompt interactively before Phase B
                        Note: until proposals carry real confidence scores, any non-`false`
                        value behaves like the legacy "safe" mode (whole-batch auto-accept).
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

Examples:
  akm improve
  akm improve memory
  akm improve skill
  akm improve skill:code-review
  akm improve workflow:incident-response --task "reduce duplication"
