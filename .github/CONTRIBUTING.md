# Contributing to akm

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Node.js](https://nodejs.org/) >= 24 and npm for npm package acceptance and global-install workflows

## Setting Up the Dev Environment

```bash
git clone https://github.com/itlackey/akm.git
cd akm
bun install
```

## Development Workflow

Run the CLI from source during development:

```bash
bun src/cli.ts <command>
```

Use an explicit invocation for the behavior you intend to test:

- Live working-tree source: `bun src/cli.ts <command>`
- Fresh built launcher: `bun run build`, then `node dist/akm <command>`
- Isolated packed-package acceptance: `bun run test:package`
- Intentional machine-wide checkout install: `bun run build:install`

Running `akm` by hand, outside `bun test`, uses the real `HOME` and your
bundles. To try something against scratch data instead, point `HOME`, `XDG_*`,
`AKM_CONFIG_DIR`, `AKM_DATA_DIR` and `AKM_BUNDLE_DIR` at a scratch directory
first.

The global checkout install deliberately replaces the globally resolved `akm`;
do not use it for routine inner-loop testing. Some development machines still
have a machine-local wrapper for historical workflows. Treat it as transitional,
leave it untouched, and do not rely on it in tests or contributor instructions.
See [Local development](../docs/maintainers/local-development.md) for exact isolated
package-acceptance commands.

### Running Tests

```bash
bun run test:unit
bun run test:integration
bun test tests/<file>.test.ts   # one file, while iterating
```

The [testing workflow](../docs/architecture/testing/testing-workflow.md) says
what each target holds and where a new test goes.

### Linting

```bash
bun run lint:fix   # Biome with --write; read git diff afterwards
bun run lint       # what CI runs: Biome, the secret-resolver and shipped-assets lints, the doc-example lint
```
What CI runs depends on the event. Every pull-request commit runs `check` (lint,
types, the unit and integration suites, the build) and one Node smoke; marking
the pull request ready for review, and every commit after that, adds the second
Node version and the two upgrade rehearsals, which also run on every push to
`main` and a release branch and on a manual run. Push a draft in batches that
you have verified locally with `bun run check`: each push is a CI run.


### Building

```bash
bun run build
```

The build compiles `src/**` only into `dist/`; `tests/release-check.sh` fails if
`dist/tests` appears.

## Required local verification

Before committing, run `bun run lint:fix`, `bunx tsc --noEmit` and the focused
tests for what you changed (`bun test tests/<file>.test.ts`).

Before pushing any branch that changes CLI output, search behavior, docs, or tests:

- run `bun run check`

For faster iteration while changing output contracts, run:

- `bun run check:changed`

`check:changed` is a quick gate for the most failure-prone areas:

- output contract baselines
- CLI end-to-end output expectations
- search-path regressions
- lint
- typecheck

Use it during development, then run `bun run check` before every push.

### Why this exists

This repository has repeatedly seen CI failures caused by output-shape changes
that updated implementation without updating end-to-end expectations. The fix is
to treat `bun run check` as the pre-push gate and to use `bun run check:changed`
while iterating on output-related changes.

## Shipping a release — migration notes

Maintainers must also follow the
[release checklist](../docs/maintainers/release-checklist.md). The Release
workflow runs the semantic, Docker, and Linux/macOS/Windows native-scheduler
gates on the commit it publishes.

`akm help migrate <version>` prints a per-release migration note to the
terminal. Each note lives as its own markdown file under
[`docs/migration/release-notes/<version>.md`](../docs/migration/release-notes/)
and is bundled with the published npm package via `package.json` `files[]`.

When you tag a new release:

1. Create `docs/migration/release-notes/<version>.md`. Lead with
   `Migration notes for akm v<version>` so the text matches the pattern the
   tests enforce.
2. Keep the note self-contained — automatic migrations, manual actions,
   publisher changes, breaking CLI/flag moves. Link to the longform guide
   (e.g. `docs/migration/v0.8-to-v0.9.md`) in the last paragraph if one
   exists.
3. Extend the `for ... of` list in `tests/migration-help.test.ts`
   (`"every bundled release-notes file is surfaced by the loader"`) so the
   new version is explicitly exercised.
4. Smoke-test end-to-end: `bun src/cli.ts help migrate <version>`.

No code change is required in `src/commands/sources/migration-help.ts` — the loader discovers
files at runtime from the release-notes directory.

## Submitting Changes

1. Fork the repository and create a feature branch from `main`.
2. Make your changes, keeping commits focused and well-described.
3. Ensure both test targets pass (`bun run test:unit` and
   `bun run test:integration`) and linting is clean (`bun run lint`).
4. Open a pull request against `main` with a clear description of the change.

## Code Style

- **TypeScript** in strict mode, using ESM modules.
- **Biome** for formatting and linting; see [Linting](#linting).
- Keep functions small and well-named. Prefer explicit types over `any`.
- Prose, templates and comments follow
  [principle 7](../docs/architecture/akm-core-principles.md#7-prose-lives-in-files-comments-say-why);
  the other rules for how code is written are in
  [Core Principles](../docs/architecture/akm-core-principles.md).
- Lessons from 0.10:
  - No test-only exports from `src/` (`_…ForTests`) where a behaviour test would do.
  - No plumbing without a production caller: a parameter, field or export only a
    test uses is deleted.
  - The CHANGELOG, the migration guide and the docs describe only behaviour that
    shipped and was checked.
  - New code and messages say "connection" and "harness", never "engine".
  - A converter step must not lose entries to key order or name collisions, and a
    test pins that.
  - Instruction files carry no dated counts and no file:line citations.

## Gotchas

- Biome 2.4.14 (the pinned version) intermittently parses a file with the wrong
  grammar (`.ts` as JSON, JSON as JS) and reports errors against correct text:
  re-run it; don't edit the file it names. A misparse under `--write` has
  rewritten valid JSON into invalid JSON once, so read `git diff` after
  `bun run lint:fix`.
- Read a test run's own exit code. Piped through `| tail` or `| grep`, a red run
  reports the pipe's.
- `TMPDIR` must be a `/tmp`-family path (`/tmp/...`, `/var/tmp/...`, or their
  macOS `/private/...` equivalents) and must contain neither `.cache` nor
  `registry`. `tests/setup-tmp-stash-guard.test.ts` exercises a production guard
  (`isTransientStashPath` in `src/core/paths.ts`) that is hardcoded to the real
  OS temp-dir families, not to whatever `TMPDIR` is, so any other `TMPDIR` makes
  that file fail for reasons unrelated to the code under test. A `TMPDIR`
  containing `.cache` or `registry` once masked a real lint-suppression bug
  (fixed in 0.9.5).
- `prepublishOnly` copies `.github/README.npm.md` over `README.md` before
  building, and `postpublish` restores `README.md` with
  `git checkout -- README.md`. That README churn is not a source edit.
- `.github/workflows/ci.yml` ignores docs-only changes (`docs/**`, `README.md`,
  any `CHANGELOG.md`, `CLAUDE.md`, `LICENSE`), so docs-only edits get no normal
  CI coverage.

## Reporting Issues

If you find a bug or have a feature idea, please open an issue on GitHub. For security vulnerabilities, see [SECURITY.md](../SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MPL-2.0](../LICENSE) license.
