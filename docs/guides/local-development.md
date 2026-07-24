# Local Development

Use an explicit launcher for each kind of contributor check. This keeps live
source, build output, packed-package behavior, and the machine-wide `akm`
installation from being mistaken for one another.

The npm package requires Node.js >= 22 and npm. A working Bun >= 1.0 is optional
for the installed launcher and remains the repository's primary development and
test runtime. The standalone binaries are runtime-free.

## Live Source

Run the working tree directly for the normal edit-test loop:

```bash
bun src/cli.ts search "deploy"
bun src/cli.ts tasks doctor
```

This executes current uncommitted source. Tests that spawn the CLI should use
the same explicit `bun src/cli.ts` form with the repository as their working
directory rather than resolving `akm` from `PATH`.

## Built Launcher

Build first, then invoke the package launcher from `dist/`:

```bash
bun run build
node dist/akm search "deploy"
node dist/akm tasks doctor
```

This checks generated imports, copied assets, and launcher behavior while still
keeping the invocation tied to this checkout. `node dist/akm` is portable across
Windows, macOS, and Linux; on POSIX systems the executable `./dist/akm` form is
also available.

## Isolated Package Acceptance

Run the repository's package acceptance command. It builds and packs the package,
installs it under an isolated temporary prefix, and exercises that installed
launcher without replacing the machine's global `akm`:

```bash
bun run test:package
```

The command builds, packs, installs under a temporary npm prefix, and checks the
installed launchers. It does not run setup or test application-state isolation.

## Intentional Global Checkout Install

Only install the checkout globally when you deliberately want the machine-wide
`akm` command to resolve to this checkout's package:

```bash
bun run build:install
command -v akm
akm --version
```

This replaces the globally resolved package and can affect agents, shells, and
scheduled tasks that invoke `akm`. Re-run `akm tasks sync --rebind` only when you
intend existing scheduler entries to capture the new installed runtime, then
verify with `akm tasks doctor`.

## Transitional Machine-Local Wrapper

Some development machines still have a historical machine-local wrapper. Leave
that file untouched, but treat it as transitional: do not document wrapper
modes, depend on it in tests, or use it to choose between source and package
behavior. Invoke `bun src/cli.ts`, `node dist/akm`, or `bun run test:package`
explicitly instead.

## Verification

Use focused tests while iterating, then the repository gates before pushing:

```bash
bun test tests/<focused-file>.test.ts
bun run check:changed
bun run check
```

For eval scripts that accept `AKM_BIN`, point it at the exact launcher under
test rather than relying on `PATH`.
