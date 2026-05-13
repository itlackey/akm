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
  --auto-accept safe   Automatically accept low-risk proposals
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
