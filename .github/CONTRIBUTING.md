# Contributing to akm

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0

## Setting Up the Dev Environment

```bash
git clone https://github.com/itlackey/akm.git
cd akm
bun install
```

## Development Workflow

Run the CLI from source during development:

```bash
bun run src/cli.ts <command>
```

### Local `akm` wrapper

If you have `~/.local/bin/akm` set up to point at this repo, it must be a **real file**, not a symlink:

```bash
cat > ~/.local/bin/akm << 'EOF'
#!/usr/bin/env bash
exec bun /path/to/agentikit/src/cli.ts "$@"
EOF
chmod +x ~/.local/bin/akm
```

**Do not** make it a symlink to `~/.bun/bin/akm`. Bun's global install chain is:

```
~/.local/bin/akm  →  ~/.bun/bin/akm  →  ~/.bun/install/global/node_modules/akm-cli/dist/cli.js
```

A symlink into that chain means any `bun install -g akm-cli` (or `akm upgrade`) silently replaces what `akm` runs with the published compiled bundle rather than your local source.

### Running Tests

```bash
bun test
```

Run the scoring benchmark suite:

```bash
bun run tests/benchmark-suite.ts
```

### Linting

```bash
bun run lint
```

### Building

```bash
bun run build
```

## Required local verification

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

## Submitting Changes

1. Fork the repository and create a feature branch from `main`.
2. Make your changes, keeping commits focused and well-described.
3. Ensure all tests pass (`bun test`) and linting is clean (`bun run lint`).
4. Open a pull request against `main` with a clear description of the change.

## Code Style

- **TypeScript** in strict mode, using ESM modules.
- **Biome** for formatting and linting. Run `bun run lint` before submitting.
- Keep functions small and well-named. Prefer explicit types over `any`.

## Reporting Issues

If you find a bug or have a feature idea, please open an issue on GitHub. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MPL-2.0](LICENSE) license.
