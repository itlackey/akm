---
title: 'Task Assets: Agent Workflows That Run While You Sleep'
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-knowledge
description: 'Task assets in akm 0.8.0 are the first-class way to define persistent, scheduled agent workflows. This post covers the YAML schema, scheduling, manual invocation, environment injection, and logging — with the Discord health report as a worked example.'
tags:
  - ai
  - agents
  - cli
  - automation
published: false
id: 3814542
---

This is part eleven in a series about managing the growing pile of skills, scripts, and context that AI coding agents depend on. [Part nine](https://dev.to/itlackey/agents-that-remember-where-they-were-1koe) covered workflow assets and resumable procedures. [Part ten](https://dev.to/itlackey/the-improvement-loop-how-akm-keeps-your-agent-sharp-2d4d) introduced the improve pipeline that continuously curates your stash. Earlier parts addressed teams, distributed stashes, and community knowledge.

Most automation with AI agents is reactive. You open a session, give the agent a task, wait for the result, close the session. The agent's clock runs when you run it.

Task assets flip that model. A task is a YAML file in your stash that defines a workflow — what to run, when to run it, what environment it needs, and how long it's allowed to take. Once registered, the task runs on schedule without your involvement. The OS scheduler calls `akm tasks run <id>`, which executes the task and writes the result to `state.db`. You find out what happened when you check `akm health` or look at the log.

This is the piece of akm 0.8.0 that makes continuous operation possible. The improve loop runs twice an hour because a task asset says it does. The hourly Discord health report fires because a task asset says it does. Neither requires an open terminal.

## The Task Asset Format

Task assets live at `<stash>/tasks/<id>.yml`. The filename is the task ID. A minimal task looks like this:

```yaml
schedule: 0 * * * *
command: akm improve --auto-accept 90
enabled: true
```

That's enough to install a cron entry and run `akm improve` at the top of every hour. The full schema adds metadata and per-task timeout control:

```yaml
schedule: "7,37 * * * *"
command: akm improve --auto-accept 90 --timeout-ms 1620000
enabled: true
timeoutMs: 1800000
name: akm-improve
description: Run the improve pass at :07 and :37 — reflect, distill, consolidate, lint, and eval.
when_to_use: Twice per hour; leaves ~23 minutes of idle headroom between completions.
tags:
  - improve
  - maintenance
```

The fields that matter most:

| Field | Required | Purpose |
|---|---|---|
| `schedule` | yes | Standard cron expression. Maps to crontab on Linux, launchd plist on macOS, schtasks XML on Windows. Wrap expressions containing special characters in quotes. |
| `command` or `prompt` | one of the two | `command` runs as a plain shell command. `prompt` dispatches through the configured agent profile. A third option, `workflow`, targets a stash workflow ref directly. |
| `enabled` | yes | `false` keeps the task definition in your stash without installing a scheduler entry. |
| `timeoutMs` | no | Per-task timeout in milliseconds, overriding whatever the agent profile sets globally. `null` removes the kill timer entirely — useful for long-running local-model tasks. |
| `name`, `description`, `when_to_use`, `tags` | no | Metadata. `name` appears in `akm tasks list`; the others exist for your own records and for search. |

## command: vs prompt:

The distinction between `command` and `prompt` reflects two different execution models.

A `command` task is a shell invocation. `akm tasks run` executes the string directly in a child process. There is no agent involved. The command can call `akm`, run a shell script, invoke any binary. The exit code is what gets logged.

```yaml
command: akm improve --auto-accept 90
```

A `prompt` task dispatches to the agent configured in your default agent profile (or the profile specified in `--profile`). The value of `prompt` becomes the task instruction. The agent runs autonomously, can use `akm` commands, write files, and call tools according to its allowed tool set. The result is determined by whether the agent exits cleanly.

```yaml
prompt: |
  Run akm wiki ingest research and then run akm wiki lint research.
  Fix any orphan pages the lint step reports.
```

The practical split: use `command` for tasks where the execution is fully scripted and the outcome is deterministic. Use `prompt` when you want the agent to exercise judgment — synthesizing content, triaging output, making decisions based on what it finds. The curate-to-wiki task is a good example of the latter: it runs a multi-step workflow where the agent reads each step's instructions, substitutes parameters, and advances the workflow run through to completion. Workflow assets themselves are covered in [part nine](https://dev.to/itlackey/agents-that-remember-where-they-were-1koe) of this series.

## Registering Tasks

There are two ways to get a task into the scheduler.

The first way is `akm tasks add`, which creates the YAML file and installs it in one step:

```sh
akm tasks add my-task \
  --schedule "0 9 * * *" \
  --command "akm improve --auto-accept 80" \
  --name "Morning improve pass" \
  --description "Daily improve at 9 AM"
```

The second way is to write the YAML file directly into your stash's `tasks/` directory and then call:

```sh
akm tasks sync
```

`sync` reconciles all `.yml` files in `tasks/` against the OS scheduler. Any task that's `enabled: true` and not yet installed gets a scheduler entry. Any task that's `enabled: false` or missing gets its entry removed. This is the right command to run after pulling stash changes that include new or updated task files.

Other task management commands:

```sh
akm tasks list                        # all defined tasks with status
akm tasks show <id>                   # parsed YAML + scheduler state
akm tasks run <id>                    # execute immediately
akm tasks enable <id>                 # install the scheduler entry
akm tasks disable <id>                # remove the scheduler entry, keep the file
akm tasks remove <id>                 # delete the file and uninstall
akm tasks history [--id <id>]         # recent runs from state.db
akm tasks doctor                      # scheduler backend + cron path
```

`akm tasks run` is the same command the scheduler calls. You can run a task immediately to test it before committing it to a schedule.

## Environment Injection with akm env run

Tasks that need secrets or environment-specific configuration use `akm env` vaults. A vault is an encrypted `.env` file stored in your stash under `env/<name>.env`. You inject it into a child process using `akm env run`:

```sh
akm env run env:fwdslsh -- bash ./scripts/post-to-discord.sh
```

The `env:` prefix is the canonical ref form. In task YAML, akm also resolves bare vault names — the worked example below uses the bare name to match the production file exactly.

In a task `command` field, the same pattern applies directly:

```yaml
command: akm env run fwdslsh -- bash /home/founder3/akm/scripts/akm-health-discord.sh
```

This injects every variable in the `fwdslsh` vault into the shell process that runs the script. The variables live only in that child process — they are never written to disk or exported to the parent environment. The task definition itself contains no secrets, only the vault reference. You can commit task YAML to your stash and share it without exposing credentials.

If a task needs only a subset of the vault's variables, `--only` narrows the injection:

```sh
akm env run env:fwdslsh --only DISCORD_WEBHOOK_URL -- bash ./post.sh
```

`--only` accepts a single key or a comma-separated list. Use `--except` to inject everything in the vault except specific keys.

## Worked Example: The Discord Health Report

This is the health report task used in production to monitor the improve pipeline:

```yaml
# ~/akm/tasks/akm-health-report.yml
schedule: 0 * * * *
command: akm env run fwdslsh -- bash /home/founder3/akm/scripts/akm-health-discord.sh
enabled: true
name: AKM Health Report → Discord
description: "Hourly: post a 4h rolling health report to Discord. Driven by
  akm health --since=4h — same data source as manual reports."
tags:
  - health
  - discord
  - monitoring
```

The task fires at the top of every hour. It injects the `fwdslsh` vault (which contains the Discord webhook URL and any other credentials the script needs), then runs the health report script. The script calls `akm health --since=4h` and `akm health --since=8h`, computes deltas between the two windows for trend context, and posts a formatted embed to Discord.

The embed has three inline fields — Output (promoted refs, merged memories, memory inference yield), Failures (chunk failures, skip reason anomalies), and Latency (median, P95, prior-window comparison) — plus a Needs Attention section that only appears when something is actually off. The footer includes the hostname and run timestamp so reports from multiple machines are distinguishable at a glance.

To register the task after writing the YAML:

```sh
akm tasks sync
akm tasks list
# → akm-health-report   0 * * * *   enabled   last run: —
```

Run it once immediately to confirm the script works before relying on the scheduled version:

```sh
akm tasks run akm-health-report
```

Check the result:

```sh
akm tasks history --id akm-health-report --limit 5
```

## Logging

Every task run is recorded in `state.db` under the `task_history` table. `akm tasks history` surfaces that data. For log output, each run writes to:

```
~/.cache/akm/tasks/logs/<id>.log
```

`akm health` inspects `task_history` for missing log files, stale active runs (tasks that started but never completed), and recent failure rates. A task run that never wrote a `tasks_completed` event shows up in `akm health` output as a stuck active run — a reliable signal that something went wrong even if the log file doesn't say much.

```sh
akm health --since 4h
```

The health check correlates the `task_history` events with the log files on disk. If a log file is missing for a completed run, `logBackingRate` drops below 1.0, which flags as a warning. This is the `task-log-backing` hard check — one of the deterministic checks that `akm health` runs before it looks at any metrics.

## Building a Task-Driven Operation

The pattern that emerges from several tasks working together is an operation that runs itself. The improve loop consolidates and curates the stash twice an hour — what that pipeline does internally is covered in [part ten](https://dev.to/itlackey/the-improvement-loop-how-akm-keeps-your-agent-sharp-2d4d). The health report surfaces the results every hour. A daily curation task pulls new articles from configured sources and ingests them into the research wiki. None of these require an open terminal.

Adding a new automated behavior follows the same steps regardless of what the task does:

1. Write the YAML to `<stash>/tasks/<id>.yml`.
2. Run `akm tasks sync` to install the scheduler entry.
3. Run `akm tasks run <id>` to test it immediately.
4. Confirm the output with `akm tasks history` and check the log.
5. Add the task file to git if you want it version-controlled with your stash.

The task YAML is the contract between what you want to happen and when it happens. The log and `state.db` are the record of what actually did.

---

Task assets are available in akm 0.8.0. The full command reference is in [docs/cli.md](https://github.com/itlackey/akm/blob/main/docs/cli.md#tasks). The environment vault documentation is in [docs/cli.md](https://github.com/itlackey/akm/blob/main/docs/cli.md#env). If you're upgrading from 0.7.x, task `.md` files from the old format are not auto-discovered — check the migration guide for the conversion path.
