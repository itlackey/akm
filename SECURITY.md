# Security policy

## Supported versions

Security fixes are made on the latest minor release line of `akm-cli`. The
0.x line is pre-1.0 — please upgrade promptly when a fix lands.

| Version | Supported |
| --- | --- |
| 0.9.x | ✅ active |
| 0.8.x | ❌ no longer maintained |
| < 0.8 | ❌ no longer maintained |

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories:

- https://github.com/itlackey/akm/security/advisories/new

If GitHub Security Advisories is unavailable, email `itlackey@gmail.com`
with the word `SECURITY` in the subject. Please include reproduction steps,
the impacted akm version, and your operating environment.

We will acknowledge receipt within 72 hours and aim to ship a fix or a
mitigation guidance within two weeks, depending on severity.

## Threat model

`akm` is a local CLI that reads and writes user files, executes user-authored
shell commands (via scripts, workflows, and agent dispatch), and talks to
explicitly configured external services (LLM endpoints, git remotes, npm,
HTTP sources). It does **not** ship telemetry, send data to anyone by
default, or open network listeners. See
[`docs/reference/data-and-telemetry.md`](docs/reference/data-and-telemetry.md) for the on-disk
inventory.

Several akm surfaces execute user-controlled code or data with the full
permissions of the akm process. These are documented design decisions, not
bugs, but you should be aware of them:

### Workflows execute shell commands with full environment access

Workflow steps run in your shell with your PATH and your environment
variables — including any secrets you have exported or loaded via
`akm env run` / `akm secret run`. **Only add workflow sources you trust.** See
[`docs/guides/run-workflows.md` — "Security: workflow sources are executed
code"](docs/guides/run-workflows.md#security-workflow-sources-are-executed-code)
for the full discussion.

### Scripts execute shell commands

`akm show scripts/<name>` returns a `run:` command line the user (or an
integrating agent) then executes. The same trust model applies: scripts you
install from third-party stashes are third-party code.

### Agents and commands embed user-authored prompts

`akm show agents/<name>` and `akm show commands/<name>` return prompt
templates and system prompts that an LLM will execute. A malicious stash
maintainer could write a system prompt that instructs the LLM to read
sensitive files in your working tree and exfiltrate them via the LLM
response. Audit the prompt body the same way you'd audit a script.

### Installing a stash means trusting its code

Installing a stash is not a data-only operation: **`<stashDir>/scripts/wiki-fetchers/*.{ts,js,mjs}` is imported and EXECUTED during `akm index`** (when a website-snapshot source in that stash is synced), with no gate, no prompt, and no allowlist. Every file in that directory is dynamically `import()`ed, and only *after* the module has fully evaluated does akm check that its default export looks like a fetcher (`{ name, matches, fetch }`) — module-level code (anything outside the exported functions) runs unconditionally before that check ever happens, and a file that fails the check still ran. There is no sandboxing: a wiki-fetcher script executes with the full permissions of the akm process, exactly like the scripts and workflow steps documented above.

This is a deliberate design decision (owner ruling), not an oversight, and it will not change without a separate decision to add a gate. **If you install a stash from a source you do not trust, you are trusting its code to run on your machine at index time** — audit `scripts/wiki-fetchers/` the same way you would audit any other executable you're about to run, before installing.

The built-in YouTube snapshot fetcher (`src/sources/snapshot-fetchers/youtube.ts`) deliberately **impersonates the YouTube Android app's InnerTube client** (`clientName: "ANDROID"`, a spoofed `clientVersion`) when calling YouTube's private `youtubei/v1/player` endpoint, because the public web client's caption URLs are Proof-of-Origin-Token gated and return empty bodies. This is known, intentional behavior needed to fetch captions at all, not a bug — documented here so it isn't mistaken for one.

### Environment and secret assets are plaintext on disk

`env` and `secret` assets are owner-permissioned plaintext under `<stash>/env/`
and `<stash>/secrets/`. They are protected against other local users by
filesystem permissions but are not encrypted at rest. Do not commit these
files to source control. Normal `akm env` and `akm secret` output never echoes
values; materialize values only at the command boundary with `akm env run`
or `akm secret run`.

The knowledge graph extracted from your assets (entities/relations) lives
only in `$DATA/index.db` and is surfaced as aggregate counts via `akm health`
(`--report` for the full breakdown) — there is no export command that writes
graph content to an arbitrary path.

### Improve / propose send asset content to the configured LLM

`akm improve` (whose strategies run processes such as reflect, distill, and
consolidate) and `akm proposal new` can send asset frontmatter and body to the
connection (or harness) selected by the command, strategy, or current defaults.
Connections live under `connections.<name>` in `~/.config/akm/config.json`,
with their keys in the environment or in `~/.config/akm/credentials.json`. If you
configure a third-party LLM, your asset content goes to that third party, and a
harness you enable (Claude Code, Codex, ...) sends it wherever it is configured
to. Use a local endpoint (for example, `http://localhost:11434/v1` via Ollama)
for assets containing secrets or private notes.

## Known non-issues

- **The `akm-cli` npm package requires Node.js >= 22 as its bootstrap.** A
  working Bun >= 1.0 is preferred for execution when it is also on `PATH`; old,
  unusable, or absent Bun installations fall back to Node.js. Bun does not
  remove the package's Node.js requirement. Standalone binaries are
  runtime-free. This is a compatibility limitation, not a security risk.
- **Workflows can read any file the akm process can read.** This is not a
  bug — see "Threat model" above.
- **Installing `akm-cli` runs the preinstall hook.** The hook only validates
  the runtime version and exits non-zero when it is unsupported; it does not
  phone home or write outside the install directory.
