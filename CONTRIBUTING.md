# Contributing to akm

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0

## Setting Up the Dev Environment

```bash
git clone https://github.com/itlackey/agentikit.git
cd agentikit
bun install
```

## Development Workflow

### Running Tests

```bash
bun test
```

### Linting

```bash
bun run lint
```

### Building

```bash
bun run build
```

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
