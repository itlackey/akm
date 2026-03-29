# Contributing to akm

Thanks for your interest in contributing to **akm** (Agent Kit Manager).

## Getting Started

```sh
git clone https://github.com/itlackey/akm.git
cd akm
bun install
```

Requires [Bun](https://bun.sh/) v1.0.0 or later.

## Development

Run the CLI locally during development:

```sh
bun run src/cli.ts <command>
```

Build the project:

```sh
bun run build
```

## Testing

Run the full test suite:

```sh
bun test
```

Run the scoring benchmark suite:

```sh
bun run tests/benchmark-suite.ts
```

## Code Quality

Before every commit, run lint/format and type checking:

```sh
bunx biome check --write src/ tests/   # Lint and auto-fix
bunx tsc --noEmit                      # Type-check without emitting
```

Or use the combined check script:

```sh
bun run check
```

## Project Structure

- `src/` -- All source code (TypeScript, ESM)
- `tests/` -- Test files (bun:test)
- `dist/` -- Build output
- `docs/` -- Documentation

This is a CLI-only package with no public API or barrel exports. See [CLAUDE.md](CLAUDE.md) for architectural rules and constraints, and [docs/technical/architecture.md](docs/technical/architecture.md) for the full technical architecture.

## Pull Requests

- Keep PRs focused on a single change.
- Include tests for new features or bug fixes.
- Ensure `bun test`, `bunx biome check --write src/ tests/`, and `bunx tsc --noEmit` all pass before submitting.
- Describe what the PR does and why in the description.

## Issues

Use [GitHub Issues](https://github.com/itlackey/akm/issues) for bug reports and feature requests. Include reproduction steps for bugs and a clear description of the expected vs. actual behavior.

## License

By contributing, you agree that your contributions will be licensed under the [MPL-2.0](LICENSE) license.
