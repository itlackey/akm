# Vault Feature Review

> Historical note: this review reflects an earlier design round that preferred
> keeping `vault load` and adding `vault exec`. The product direction has since
> changed. Current vault UX is `akm vault path`, `akm vault run <ref[/KEY]> -- <command>`,
> stash-wide `akm vault list`, and `akm show vault:<name>` for per-vault metadata.

## Goal

Review the current `akm vault` implementation and decide the best next changes to improve automation ergonomics without weakening the current secret-handling safety model.

This document synthesizes parallel reviews from three perspectives:

- UX / agent ergonomics
- security / operational safety
- implementation cost / fit with the current codebase

## Current State

The current vault design is intentionally conservative.

- Vault values are stored in `.env` files under `vaults/`.
- `akm vault list` / `show` surface only keys and comments, not values.
- Vault values are not indexed into search content or returned from `akm show`.
- `akm vault load <ref>` is the only CLI path intended to hydrate environment variables into the current shell.
- `vault load` parses with `dotenv`, writes a mode-`0600` shell-export script to a temp file, and prints a shell snippet that sources and removes that temp file.

Relevant implementation anchors:

- `src/commands/vault.ts`
- vault CLI commands in `src/cli.ts`
- `tests/vault.test.ts`
- `tests/vault-load-error.test.ts`

## What Works Well

The current implementation has several strong properties.

- Secret values do not flow through normal structured output.
- Vault metadata exposure is narrow: keys and comments only.
- Parsing is delegated to `dotenv` instead of ad hoc shell parsing.
- `vault load` uses literal shell exports with single-quote escaping, which is safer than sourcing the raw `.env` file.
- The temp file is mode `0600` and removed by the emitted shell snippet.
- The implementation already exposes the right programmatic primitive for future improvements: `loadEnv()` / `injectIntoEnv()`.

## Main Pain Points

The current design is safe, but awkward in automation-heavy workflows.

### 1. `vault load` is a good primitive but a poor primary UX

`vault load` is fundamentally about mutating the current shell environment. That is the right primitive for interactive shell use, but it is not the best abstraction for one-shot command execution.

In practice, many users and agents do not want "load this into my current shell". They want "run this command with the vault applied".

### 2. `eval "$(akm vault load ...)"` is ergonomically hostile in agent contexts

The documented load pattern is correct for parent-shell mutation, but it is often blocked by shell-safety layers in automation tooling. Even when it works, it requires the caller to reason about shell semantics instead of intent.

### 3. Documentation is split across multiple mental models

Different docs/examples imply different invocation styles. The product should have one canonical recommendation for interactive use and one canonical recommendation for automation.

### 4. Vault refs are not strong first-class targets in related flows

In practice, vaults are manageable via `akm vault ...`, but they are less usable as normal searchable/addressable refs in adjacent commands such as feedback-driven workflows.

### 5. Path exposure is more capability than most callers need

Several current vault subcommands surface raw filesystem paths. That is useful for debugging, but it is not the safest or most user-focused primary interface.

## Options Considered

### Option A: Keep `vault load` as the only integration surface

Pros:

- no new surface area
- already implemented and tested

Cons:

- continues the automation awkwardness
- keeps shell mechanics as the main integration story

Decision:

- not sufficient on its own

### Option B: Add `akm vault exec <ref> -- <cmd> [args...]`

This command would:

- resolve the vault ref
- parse the vault with `dotenv`
- merge values into the child process environment
- execute the requested command directly
- inherit stdout/stderr
- return the child exit code
- leave the parent shell unchanged

Pros:

- directly matches the main automation use case
- avoids `eval`
- fits cleanly with the existing `loadEnv()` / `injectIntoEnv()` helpers
- avoids creating extra secret-bearing files for normal automation

Cons:

- adds CLI surface area
- needs careful argument parsing after `--`
- cannot solve the parent-shell mutation use case by itself

Decision:

- preferred next feature

### Option C: Add `akm vault path <ref>`

Pros:

- simple to implement
- easy for humans to understand

Cons:

- encourages callers to bypass the safer interface
- pushes quoting / sourcing / cleanup concerns onto the caller
- exposes raw filesystem paths as a first-class integration mechanism

Decision:

- possible as a supplemental debug escape hatch, but not recommended as the main fix

### Option D: Add `akm vault write-shell-file` or `write-env-file`

Pros:

- avoids `eval`
- can make intermediate artifacts explicit

Cons:

- creates extra secret-bearing files
- shifts cleanup and permission handling to the caller
- largely duplicates what `vault load` or the raw vault file already provide

Decision:

- defer unless a concrete integration requires it

### Option E: Add a single-key temp export command such as `vault use <ref>/KEY`

Pros:

- initially sounds simpler for shell users

Cons:

- still relies on sourcing/eval-like behavior
- creates new temp secret artifacts
- adds key-path parsing and more shell-centric complexity
- weaker general-purpose value than `vault exec`

Decision:

- reject for now

## Recommended Change Set

### 1. Keep `akm vault load` unchanged

`vault load` still solves a real problem: loading secrets into the current shell session. That cannot be replaced by a child-process command.

It should remain the low-level, interactive-shell primitive.

Canonical guidance for interactive use:

```sh
eval "$(akm vault load vault:prod)"
```

### 2. Add `akm vault exec`

Recommended shape:

```sh
akm vault exec vault:prod -- env
akm vault exec vault:prod -- bun run deploy
akm vault exec vault:prod -- bash -lc 'echo "$API_KEY" >/dev/null && ./deploy.sh'
```

Behavior:

- load vault values in memory only
- merge them into the child env
- do not mutate the parent env
- do not use a shell implicitly
- preserve child exit status

Recommended guidance for automation:

```sh
akm vault exec vault:prod -- <command> [args...]
```

### 3. Improve docs and CLI hints

Standardize the mental model:

- interactive shell hydration: `vault load`
- one-shot command execution: `vault exec`

Docs and hints should stop mixing multiple primary patterns.

### 4. Improve vault discoverability as refs

Vaults should remain value-safe, but they should be easier to target in normal ref-oriented flows.

Good follow-up improvements:

- make vault aliases/searchability stronger
- ensure `vault:<name>` is a stable, discoverable first-class ref
- consider reducing raw-path exposure in standard vault command output

## Explicit Non-Goals

The following should not be the primary solution.

- making raw vault file paths the main integration surface
- encouraging callers to source raw `.env` files directly
- introducing an ambient-state command like `vault use` that changes hidden global state
- printing values to stdout or structured output
- adding shell-string execution as the default for `vault exec`

## Security Notes

The existing security model should remain intact.

- values must never appear in search, show, structured CLI output, or normal logs
- `vault exec` should inject env directly into the child process, not print shell exports
- shell execution should be opt-in by the caller (`bash -lc ...`), not implicit in `vault exec`
- tests must continue to cover hostile values containing shell metacharacters, command substitution syntax, quotes, and whitespace

Potential future tightening:

- reconsider whether standard vault command output should include raw filesystem paths by default
- explicitly document that comments are treated as non-secret metadata and should not contain secret material

## Minimal Implementation Plan

### CLI

Add a new subcommand under `vault`:

- `vault exec <ref> -- <cmd> [args...]`

Argument rules:

- require a vault ref
- require at least one token after `--`
- do not parse the child command through a shell by default

### Runtime

Implementation sketch:

1. resolve vault path with the existing `resolveVaultPath()`
2. read values with `loadEnv()`
3. spawn the child with inherited stdio and merged env
4. propagate exit code / signal

### Tests

Add a dedicated `vault exec` test file that covers:

- child sees vault vars
- parent env is unchanged
- missing vault errors cleanly
- child exit code is preserved
- hostile values are inert unless the caller explicitly opts into shell mode
- no secret values appear in AKM stdout/stderr envelopes

### Docs

Update:

- CLI docs
- vault help text
- output hints
- blog/examples that currently imply the load path is the primary automation path

## Final Recommendation

The best next move is small and clear:

1. keep `akm vault load` as the current-shell primitive
2. add `akm vault exec` as the preferred automation command
3. standardize docs around those two roles
4. improve vault ref discoverability in adjacent flows

This preserves the current safety model while removing most of the awkwardness that showed up in agent-driven workflows.
