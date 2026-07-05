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
                        Default when flag is absent: ON at threshold 90 (all sub-processes).
                        --auto-accept            same as --auto-accept=90
                        --auto-accept=<N>        integer 0-100; accept proposals at or above N
                        --auto-accept=safe       alias for 90 (back-compat, not deprecated)
                        --auto-accept=false      disable auto-accept for all sub-processes;
                                                 reflect/distill proposals go to the queue and
                                                 consolidation will prompt interactively on HTTP paths
                        Note: until proposals carry real confidence scores, any non-`false`
                        value behaves like the legacy "safe" mode (whole-batch auto-accept).
  --profile <name>     Improve profile to apply. Built-ins: default, quick,
                        thorough, memory-focus, frequent, catchup, consolidate,
                        graph-refresh, synthesize, reflect-distill,
                        proactive-maintenance, recombine-only. User-defined
                        profiles under `profiles.improve.<name>` in config are
                        also accepted. Profiles bundle process gating, type
                        filters, and run-level autoAccept/limit defaults. Falls
                        back to `defaults.improve` in config, then to "default".
                        An unknown name is a hard error listing the valid names
                        (no silent fallback to default).
                        Sync behavior by profile: default and thorough enable
                        auto-commit + push; quick and memory-focus skip sync.
  --sync               Commit (and optionally push) the git-backed primary
                        stash when the run finishes. Use --no-sync to disable.
                        Default: per profile config (enabled for default and
                        thorough, disabled for quick and memory-focus).
  --push               Push after the end-of-run sync commit when the stash
                        is writable and has a remote configured. Use --no-push
                        to commit only. Default: per profile config (true when
                        sync is enabled).
  --consolidate-recovery <mode>
                        Recovery mode for stale consolidate journals: abort (default) or clean
  --require-feedback-signal
                        Only process refs with recent feedback signal events
  --min-retrieval-count <n>
                        Retrieval fallback threshold when no recent feedback exists (default: 5)
  --json-to-stdout      Emit the full JSON result on stdout (legacy behaviour).
                        (0.8.0+: full result is recorded in the improve_runs table of
                        state.db and stdout is empty; use --json-to-stdout for the prior
                        behaviour, e.g. `akm improve --json-to-stdout | jq`.)

Examples:
  akm improve
  akm improve memory
  akm improve skill
  akm improve skill:code-review
  akm improve workflow:incident-response --task "reduce duplication"
  akm improve --profile quick
  akm improve --profile memory-focus
  akm improve --no-sync
  akm improve --no-push
