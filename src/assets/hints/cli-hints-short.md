# akm CLI

`akm` is a searchable library of skills, scripts, commands, agents, knowledge, workflows, memories and lessons. Search it before writing something from scratch. Output is JSON by default.

## Find and read

```sh
akm curate "<task>"                  # Best matches for a task, with previews (start here)
akm curate "<task>" --max-tokens 4000 # Same hits' content as one bundle of at most 4000 tokens
akm search "<query>"                 # Local sources (or the project's `from`); --type <t> filters
akm search "<query>" --from all      # Also search registries
akm show <ref>                       # Read an asset
akm run <ref>                        # Run an agent, command, task or workflow asset
akm doctor                           # Health checks; `doctor metrics|info|log` report
akm help <command>                   # A command's options
akm env run <ref> -- <cmd>           # Inject an env asset's values (secrets: akm secret run <ref> <VAR> -- <cmd>)
```

For a large document, `akm show <ref> --outline` returns its outline (`toc`, no body); `akm show <ref>#<slug>` reads one section.

## Feedback

`akm feedback <ref> --positive` records that the asset helped (it raises its ranking and does not trigger a rewrite).

Record negative feedback only when the asset's content is wrong or stale, and say what is wrong and what it should say. `akm feedback <ref> --negative --reason "<what is wrong and what should change>"` flags it: the next improve run may repair its description, title or `when_to_use` from your reason, but not its text. A note that simply did not fit your task is not negative feedback: record nothing for it. Once you have verified the correct fact, add the exact fix: `--replace "<exact current text>" --with "<corrected text>" --source "<URL, command or file>"`. A note that is outdated can be marked with `--outdated`, or `--superseded-by <ref>` when another note replaces it. A failed akm command (e.g. `akm show` erroring) is not feedback on the asset.

## Writing

```sh
akm remember "note"                  # Record a memory
akm import ./doc.md                  # Import a knowledge doc
akm proposal list|show|diff|accept|reject   # Review queued changes
akm improve <ref>                    # Propose an improvement (a proposal)
```

Generators emit proposals. By default `improve` accepts a proposal whose quality check passed on that exact content; the rest wait for `akm proposal accept`. An `akm feedback --replace` fix is applied at once (`akm proposal revert` undoes it). `improve` also purges graced archives and commits (and pushes a writable git bundle) what it accepted.

## Errors and exit codes

On failure stderr carries `{"ok": false, "error": "...", "code": "...", "hint": "..."}`; `hint` is a corrective action.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Not found or command-reported failure |
| 2 | Usage / bad input |
| 4 | Health warning (`akm doctor`) |
| 70 | Internal / unclassified error |
| 75 | Transient: retry shortly |
| 78 | Configuration error |
