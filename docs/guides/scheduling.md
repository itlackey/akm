# Scheduling

This guide covers running akm tasks (`akm improve` and other background work)
on a clock: the one OS scheduler entry that does it, how `akm setup` reviews
task definitions before touching the scheduler, how to verify the result, and
what to do on an installation that does not own the OS scheduler (a container,
a sandbox, anything that moves akm's directories).

## How it works

akm puts **one** entry in the OS scheduler per user — a crontab block on Linux,
a LaunchAgent on macOS, a Task Scheduler task on Windows. It runs
`akm task dispatch` every minute. That command reads `scheduler.enabled` from
your config, reads only those task files, compares each `schedule:` with the
current minute, and starts every task that is due as a separate, detached
`akm task run`, then exits. Nothing about a task is copied into the OS:

- editing a task's `schedule:` takes effect on the next minute;
- `akm task enable`, `disable` and `add` edit your config and task files, then sync the entry:
  the first enabled task installs it and the last disabled one removes it;
- a task that is still running from an earlier minute is not started again
  (overlap is skipped on every OS);
- one cron grammar works everywhere; the OS never limits which expressions you can use;
- a dispatch that starts late (a busy host, a short sleep) evaluates the minutes
  it missed, at most the last five, and runs a task due in several of them once.
  A task whose minute passed while the machine was off does not run when it comes
  back;
- times are read as wall-clock time in the host's time zone, so across a daylight-saving
  change a task set inside the skipped hour (`30 2 * * *` in spring) does not run that
  day, and one set inside the repeated hour (`30 1 * * *` in autumn) runs twice.

The OS entry is written, and kept, by `akm task sync`:

```sh
akm task sync            # install the entry when a task is enabled, remove it when none is
akm task sync --rebind   # point the entry at this akm and this shell's PATH
```

`akm task enable`, `disable` and `add` run the sync themselves, so it is only needed
to repair the entry or to rebind it. When their sync fails (no `crontab` on `PATH`, say) the
change stays saved and the result carries a warning; fix it and run `akm task sync`. The entry records an absolute launcher and the
`PATH` of the shell that writes it (cron, launchd and Task Scheduler start jobs with
almost no `PATH`), and keeps both until `--rebind`. An akm that is carried inside
another package or app (a plugin's bundled copy, Desktop's own binary) does not
write the entry, because its path moves when that package updates; run
`akm task sync` from an akm of your own, or `akm task dispatch` from your own supervisor.

## Review tasks during setup

Interactive setup reviews every embedded task definition — both the
general-purpose core task-template set and the maintainer-oriented
multi-cadence improve task set — in one pass. See the
[task CLI reference](../reference/cli.md#task) for the full template list.

```sh
akm setup
```

Before any change, setup shows every reviewed task's schedule and enabled state
and asks one activation question. Confirming prepares the task files, updates
`scheduler.enabled` and runs the scheduler sync; declining leaves both task
files and scheduler state unchanged.

## Verify

```sh
akm task doctor
```

`akm task doctor` reports the scheduler backend, the installed entry (its
launcher and the tasks it fires), and warnings (including any enabled task that
cannot run: a deleted file, an inactive bundle, a schedule that does not parse;
`akm health` reports the same) — run it after any setup pass,
and again after a `--rebind`, to confirm the scheduler state matches what you
expect. `akm task history` shows what ran.

## Non-interactive setup skips schedules

`akm setup --yes`, config-file setup, and CI runs skip the task step
entirely: neither task definitions nor the OS scheduler entry are created or
changed. Run interactive `akm setup` to review, prepare, and activate tasks.

## Task definitions vs. scheduler state

Task definitions live under `<bundle>/tasks/` as task source v4 `.yml` sources;
the [task source reference](../reference/tasks.md) defines their executable and
scheduling grammar. A definition cannot enable itself: the refs this host runs
live separately in `config.json` under `scheduler.enabled`, a list of
fully-qualified refs. Use `akm task enable <bundle>//tasks/<id>` or `akm task
disable <ref>` to change it without editing bundle content. Removing a bundle
drops its refs from the list; disabling a bundle leaves them inert. A config
without the list has never chosen and schedules nothing.

A scheduled fire reads the task's current source and freezes a fresh plan for
that run.

## An installation that does not own the OS scheduler

The OS scheduler is one namespace per user, shared by every akm installation and
every sandbox on the machine, so akm writes it for the user's **default**
installation only: the one whose config, data, cache and state directories are
where `HOME` puts them, read from the default config file. A config file other than
the default (`--config`, `AKM_CONFIG_FILE`), or an `XDG_*_HOME` that moves one of
those directories, makes an installation non-default. A `paths` key in the default file does not: dispatch
reads that file. `akm task sync` then writes nothing and says so; run
`akm task dispatch` every minute from your own supervisor, with that
installation's environment:

```
* * * * * /usr/local/bin/akm task dispatch
```

in a container's supercronic file (the image's environment reaches the job), or
a systemd timer, or any scheduler you run. Dispatch is an ordinary akm
command: it finds config, bundles and directories the way every other command
does. `akm task doctor` and `akm health` leave the OS entry to the default
installation.

## A scheduled `akm improve` covers one bundle

An `akm improve` run improves one bundle, the one it writes to: `--bundle`,
else the working bundle. A scheduled run uses the working bundle of the
installation that dispatches it, so a scheduled `akm improve` covers that bundle
and leaves your other bundles alone, even the writable ones. To improve
another bundle on a schedule, give it a task of its own; the `--bundle` inside
the command is `akm improve`'s own:

```sh
akm task add improve-team --schedule "15 3 * * *" \
  --command "akm improve --bundle team"
```

Leave `--skip-if-locked` off a once-a-night run: if a short-cadence improve task
holds the lock when it fires, the run fails with `IMPROVE_LOCK_HELD` (exit 75) and
is recorded, rather than being silently skipped. Put `--skip-if-locked` on the
frequent tasks, and give them a `--timeout-ms` that ends before the nightly starts.
The shipped `improve/akm-improve-consolidate` task does both: it runs at `:20`
every four hours with `--timeout-ms 3600000`, so the 00:20 run is over by 01:20,
well before the 02:00 nightly.

## Rerunning setup preserves the entry

Rerunning `akm setup` does not rebind an entry that is already installed.

## Upgrading from akm 0.9

akm 0.9 wrote one scheduler row per task (a `# akm:task <id>` crontab block and a
shared `# akm:env` PATH block, a `com.akm.task.<id>` LaunchAgent, a `\akm\<id>`
task). akm 0.10 replaces all of them with the one entry, in the same operation,
so nothing fires twice: `akm migrate apply` (which `akm upgrade` runs) does it,
and so does `akm task sync`. The old rows keep working until then — they run
`akm task run <id> --scheduled`, which still exists. A row that names another
installation's directories (a sandbox's `AKM_BUNDLE_DIR` or `AKM_STATE_DIR`) is
left where it is and reported; remove it from the OS scheduler by hand once its
bundle directory is gone. A row that names the working bundle in `AKM_BUNDLE_DIR`
(every row 0.9.32 and 0.10 wrote does) keeps running and is replaced by the sync:
akm ignores a value that names the bundle it resolves without it. A row that sets
`AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR` or `AKM_CACHE_DIR`, or an
`AKM_BUNDLE_DIR` naming another bundle, stops working with this release: akm no
longer reads them and refuses to start with one set (see
[Retired location variables](../reference/configuration.md#retired-location-variables)).
The report says so. Run `akm migrate apply` with that installation's environment,
then run `akm task dispatch` from its own supervisor with `AKM_CONFIG_FILE` set, and
remove the row.

## Migrating or repairing the entry (`--rebind`)

If akm was moved, reinstalled under a different package prefix, or repaired
after an installation problem, rewrite the entry deliberately:

```sh
akm task sync --rebind
akm task doctor
```

Use `--rebind` only for that explicit runtime migration or repair — it
captures the current installed runtime and `PATH`, replacing whatever the entry
had. `akm health`'s `scheduler-binary` advisory warns when the entry's akm
reports a different version than the running one.

## See also

- [Getting Started](getting-started.md) — the first-run path
- [CLI Reference: task](../reference/cli.md#task) — the full `task` command
  group, including `add`, `enable`, `disable`, `dispatch`, `run`, `sync`,
  `doctor`, and `history`
- [Task source reference](../reference/tasks.md) — exact file grammar,
  targets, triggers, and migration
