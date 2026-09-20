# Scheduling

This guide covers running akm tasks — `akm improve` and other background
work — through the OS scheduler (cron / launchd / schtasks) safely: how
`akm setup` reviews task definitions before touching the scheduler, how to
verify the result, and how to migrate or repair scheduler bindings after
moving or reinstalling akm.

## Review tasks during setup

Interactive setup reviews every embedded task definition — both the
general-purpose core task-template set and the maintainer-oriented
multi-cadence improve task set — in one pass. See the
[task CLI reference](../reference/cli.md#task) for the full template list.

```sh
akm setup
```

Before any OS scheduler change, setup shows every reviewed task's schedule
and enabled state and asks one explicit activation question. Confirming runs
the scheduler sync; declining leaves both task files and scheduler state
unchanged.

**Safety note:** schedule activation always requires an explicit confirmation
after reviewing the complete task summary. Nothing is written to the OS
scheduler without that review step.

## Verify

```sh
akm task doctor
```

`akm task doctor` reports the scheduler backend, paths, task state, and
warnings — run it after any setup pass, and again after a `--rebind` (below),
to confirm the scheduler state matches what you expect.

## Non-interactive setup never activates schedules

`akm setup --yes`, config-file setup, and CI runs skip the task step
entirely: neither task definitions nor OS scheduler entries are created or
changed. Run interactive `akm setup` to review, prepare, and activate tasks.

## Task definitions vs. scheduler state

Task definitions live under `<bundle>/tasks/` as task source v4 `.yml` sources;
the [task source reference](../reference/tasks.md) defines their executable and
scheduling grammar. A definition cannot enable itself: this host's exact
activated refs live separately in `config.json` under `scheduler.enabled`.
Use `akm task enable <bundle>//tasks/<id>` or `akm task disable <ref>` to
change that local grant without editing bundle content. An unscoped `akm task
sync` reconciles activated refs from every enabled configured bundle.

Native scheduler entries are separate OS state. Activation captures the
installed akm runtime so scheduled execution does not silently switch to a
different checkout or package. Editing definitions and running ordinary `akm
task sync` preserves that captured runtime.

A scheduled fire re-reads the guarded current source and creates a fresh
durable-v4-family freeze at executable `irVersion: 5`.
Scheduler sync/validation evidence is not an executable snapshot and is never reused as the later run plan.

## Rerunning setup preserves scheduler bindings

Rerunning `akm setup` preserves existing scheduler bindings by design — it
will not silently rebind entries that are already activated.

## Migrating or repairing scheduler bindings (`--rebind`)

If akm was moved, reinstalled under a different package prefix, or repaired
after an installation problem, migrate scheduler entries deliberately:

```sh
akm task sync --rebind
akm task doctor
```

Use `--rebind` only for that explicit runtime migration or repair — it
captures the current installed runtime, replacing whatever runtime a prior
activation had captured.

If you change the AKM storage path during reconfiguration, or move or install
akm at a new runtime path, follow setup with `akm task sync --rebind`; setup
never silently rebinds existing entries on your behalf.

## See also

- [Getting Started](getting-started.md) — the first-run path this guide was
  split out of
- [CLI Reference: task](../reference/cli.md#task) — the full `task` command
  group, including `add`, `enable`, `disable`, `run`, `sync`, `doctor`, and
  `history`
- [Task source reference](../reference/tasks.md) — exact file grammar,
  targets, triggers, and migration
