# Local development on a machine running akm

This page is for contributors whose laptop also runs `akm` for real work — i.e., dogfooding. The goal is to keep your day-to-day `akm` command decoupled from your in-flight source edits.

## The problem

The naïve setup is a shell alias or wrapper that runs `src/cli.ts` directly:

```bash
alias akm='bun ~/code/github/itlackey/akm/src/cli.ts'
```

Every invocation of `akm` then executes whatever is in the working tree at that moment — half-finished refactors, broken branches, uncommitted experiments. And shell aliases only apply to interactive shells, so scripts and agents may resolve `akm` differently from your prompt.

## The fix

A three-mode wrapper at `~/.local/bin/akm`. One install, no version-management bookkeeping. The mode is picked by `AKM_MODE`:

| Mode | Resolves to | Use when |
|---|---|---|
| `build` (current default) | `<repo>/dist/cli.js` | Day-to-day, while actively developing. Behavior matches the last `bun run build`, not the live source. |
| `stable` | The npm global install (`npm install -g akm-cli`) — the ONE canonical install | Comparing against the published version. **This will become the default after 0.8.0 GA** — flip `DEFAULT_MODE` in the wrapper. |
| `dev` | `<repo>/src/cli.ts` | Intentionally testing in-flight source changes. |

`AKM_DEV_REPO` overrides the repo path (default `~/code/github/itlackey/akm`). `AKM_STABLE_BIN` overrides the global-install lookup if you want to pin stable to a specific binary or `dist/cli.js`.

## Setup

```bash
# 1. Drop the wrapper on PATH ahead of any other akm install.
#    The wrapper is the file you're reading the docs for; the canonical copy
#    lives at ~/.local/bin/akm on a working machine.
chmod +x ~/.local/bin/akm
which akm   # should print /home/<you>/.local/bin/akm

# 2. Make sure there's a build to point at.
cd ~/code/github/itlackey/akm
bun run build

# 3. (Optional) install the published version for `stable` mode.
#    The npm package requires Node.js >= 22.
npm install -g akm-cli
```

If you previously had `alias akm='bun .../src/cli.ts'` in `~/.profile`, `~/.bashrc`, or `~/.zshrc`, remove or comment it out — an alias shadows the wrapper in interactive shells only and makes "which akm runs?" non-deterministic across contexts.

> **Heads up:** the npm package requires Node.js >= 22 to bootstrap. Its
> launcher prefers a working Bun >= 1.0 on `PATH` and otherwise uses Node.js;
> the standalone binary remains runtime-free. Keep the npm global as the only
> stable candidate (plus an explicit `AKM_STABLE_BIN` override) so a stale
> package-manager fallback cannot silently run against shared config and DBs.

## Workflow

```bash
# Default — runs <repo>/dist/cli.js
akm search …

# Rebuild after changes, then dogfood (still the default mode)
bun run build && akm search …

# Inner loop on a feature — run live source, no build needed
AKM_MODE=dev akm search …

# Compare against the published version
AKM_MODE=stable akm search …
```

## After 0.8.0 GA

Once the published version is what most users run, change `DEFAULT_MODE="build"` to `DEFAULT_MODE="stable"` in `~/.local/bin/akm`. Day-to-day `akm` then matches what users see, and dogfooding becomes an explicit `AKM_MODE=build akm …`.

## Running tests and eval scripts against live source

Two patterns coexist in the repo:

- **Unit/integration tests** in `tests/` that spawn the CLI use `bun ./src/cli.ts` directly, with `cwd` set to the repo root. They run live source regardless of `AKM_MODE` or PATH state — no setup needed. Follow the same pattern in any new test that needs to shell out.
- **Eval scripts** under `scripts/akm-eval/` (`akm-eval-run`, `akm-eval-replay`, `akm-eval-graph-ablation`) are user-facing CLIs and default to `process.env.AKM_BIN ?? "akm"`. When iterating on the eval pipeline locally:

  ```bash
  # Option A: point AKM_BIN straight at the source
  AKM_BIN="bun $(pwd)/src/cli.ts" scripts/akm-eval/bin/akm-eval-run …

  # Option B: rely on the wrapper's dev mode
  AKM_MODE=dev scripts/akm-eval/bin/akm-eval-run …   # because AKM_BIN defaults to "akm", which is the wrapper
  ```

  Option A is more explicit and survives even if the wrapper's default changes. Option B is shorter.

A handful of unit tests in `tests/akm-eval-*.test.ts` construct an `EvalContext` with `akmBin: "akm"` for type completeness, but those tests cover pure classifier/judge functions and never actually spawn anything — the field is unused at runtime, so it does not need to change.

## What this isn't

- Not a replacement for `npm publish` or release validation. Run `bun run check` and `tests/release-check.sh` before shipping.
- Not state isolation. All three modes share `~/.local/share/akm/` (akm's data dir — config, indexes, state DBs). A source-mode run that writes a broken config will affect the other modes too. Use `AKM_CONFIG_DIR` if you need a quarantined config for risky experiments.
