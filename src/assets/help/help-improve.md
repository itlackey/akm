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
      Example: akm improve workflows/release-checklist

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
                        DEPRECATED (0.9.0) and ignored. The confidence gate was
                        removed; proposals always queue for review — adjudicate
                        with `akm proposal` or the drain engine. The flag still
                        parses (with a warning) so existing scheduled tasks keep
                        working; it will be removed in 0.10.
  --strategy <name>    Improve strategy to apply. Built-ins: default, quick,
                        thorough, memory-focus, frequent, catchup, consolidate,
                        graph-refresh, reflect-distill,
                         proactive-maintenance. User-defined
                         strategies under `improve.strategies.<name>` in config are
                         also accepted. Strategies bundle process gating, type
                        filters, and run-level limit defaults. Falls
                         back to `defaults.improveStrategy` in config, then to "default".
                        An unknown name is a hard error listing the valid names
                        (no silent fallback to default).
                         Sync behavior by strategy: default and thorough enable
                        auto-commit + push; quick and memory-focus skip sync.
  --sync               Commit (and optionally push) the git-backed primary
                        stash when the run finishes. Use --no-sync to disable.
                         Default: per strategy config (enabled for default and
                        thorough, disabled for quick and memory-focus).
  --push               Push after the end-of-run sync commit when the stash
                        is writable and has a remote configured. Use --no-push
                         to commit only. Default: per strategy config (true when
                        sync is enabled).
  --consolidate-recovery <mode>
                        Recovery mode for stale consolidate journals: abort (default) or clean
  --require-feedback-signal
                        Only process refs with recent feedback signal events
  --min-retrieval-count <n>
                        Retrieval fallback threshold when no recent feedback exists (default: 5)
  --timeout-ms <n>      Wall-clock budget for the entire live run (default: 7200000)
  --skip-if-locked      Exit 0 without doing work when another improve run owns
                        the whole-run lock; no triage, indexing, events, or sync
  --json-to-stdout      Emit the full JSON result on stdout (legacy behaviour).
                        (0.8.0+: full result is recorded in the improve_runs table of
                        state.db and stdout is empty; use --json-to-stdout for the prior
                        behaviour, e.g. `akm improve --json-to-stdout | jq`.)

Examples:
  akm improve
  akm improve memory
  akm improve skill
  akm improve skills/code-review
  akm improve workflows/incident-response --task "reduce duplication"
  akm improve --strategy quick
  akm improve --strategy memory-focus
  akm improve --no-sync
  akm improve --no-push
