# AKM Repo Notes

akm is a Bun-first CLI. This file is how to work here and where to look; the linked documents hold the details. Read the one for the area you are changing before you change it.

## How to work

**Think before coding.** Don't assume. Don't hide confusion. Surface tradeoffs.
- State your assumptions explicitly. If uncertain, ask.
- If a request has more than one reading, present them; don't pick one silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what is confusing and ask.

**Simplicity first.** The minimum code that solves the problem; nothing speculative.
- No features beyond what was asked, no abstractions for single-use code, no flexibility or configurability nobody requested, no error handling for impossible scenarios.
- If you wrote 200 lines and it could be 50, rewrite it. Would a senior engineer call it overcomplicated? Then simplify.

**Surgical changes.** Touch only what you must; clean up only your own mess.
- Don't "improve" adjacent code, comments or formatting, and don't refactor what isn't broken. Match the existing style.
- Remove the imports, variables and functions your change made unused. Mention other dead code; don't delete it unless asked.
- Every changed line traces to the request.

**Goal-driven execution.** Define success criteria and loop until they are verified.
- "Add validation" → write tests for the invalid inputs, then make them pass. "Fix the bug" → write a test that reproduces it, then make it pass. "Refactor X" → the tests pass before and after.
- For a multi-step task, state a brief plan with a check for each step: `1. [step] → verify: [check]`.

## Correcting or simplifying an existing system

The failure to avoid is treating something other than the user's stated intent as the authority: the existing code, a prior decision, the shipped state, or an option you invented.
1. Existing code is not a specification. Complexity you find is a suspect, not a requirement. When code contradicts the stated goal, the code changes; don't preserve, extend or build around it "to be safe".
2. Subtract before you add. More abstraction is not the fix for over-engineering. Any new layer, option, mode or knob must earn its place against the stated goal; default to no.
3. Maturity is not correctness. "Shipped", "ratified", "tested", "already there" are not evidence the thing is right.
4. When told to remove something, remove it. If removal is genuinely risky, state the risk in one line and proceed.
5. Don't manufacture decisions. Check whether what the user already said answers it, and never offer an option that contradicts their stated intent.
6. If your recommendation contradicts the user's stated goal, you drifted, not them. Re-read the request.
7. Match the response to the moment: state the change and the risk, then stop.

## Commands
- `bun install`; `bun run build`.
- Before committing: `bun run lint:fix`, `bunx tsc --noEmit`, the focused tests (`bun test tests/<file>.test.ts`), `bun run check:changed`. CI runs `bun run check`.
- Run the working tree as `bun src/cli.ts …`. A bare `akm` is the installed copy, using the real config and bundles.

## Where the details live
- Contributing, code style, lint and commit rules, and known gotchas: `.github/CONTRIBUTING.md`.
- How code here is written (guards, one place per policy, formats, comments, harnesses): `docs/architecture/akm-core-principles.md`.
- What every command guarantees, and module boundaries: `docs/architecture/architecture.md`.
- Stored formats and migration: `docs/architecture/persisted-data-compat.md`.
- Writing, placing and running tests: `docs/architecture/testing/testing-workflow.md`.
- Config, connections, harnesses and how akm runs one, model-call defaults: `docs/reference/configuration.md`. Commands, flags, exit codes: `docs/reference/cli.md`.
- Running from source, releases: `docs/maintainers/`.
