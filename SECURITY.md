# Security policy

## Supported versions

Security fixes are made on the latest minor release line of `akm-cli`. The
0.x line is pre-1.0 — please upgrade promptly when a fix lands.

| Version | Supported |
| --- | --- |
| 0.8.x  | ✅ active |
| 0.7.x  | ❌ no longer maintained |
| < 0.7  | ❌ no longer maintained |

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
[`docs/data-and-telemetry.md`](docs/data-and-telemetry.md) for the on-disk
inventory.

Several akm surfaces execute user-controlled code or data with the full
permissions of the akm process. These are documented design decisions, not
bugs, but you should be aware of them:

### Workflows execute shell commands with full environment access

Workflow steps run in your shell with your PATH and your environment
variables — including any secrets you have exported or loaded via
`akm vault load`. **Only add workflow sources you trust.** See
[`docs/features/workflows.md` — "Security: workflow sources are executed
code"](docs/features/workflows.md#security-workflow-sources-are-executed-code)
for the full discussion.

### Scripts execute shell commands

`akm show script:<name>` returns a `run:` command line the user (or an
integrating agent) then executes. The same trust model applies: scripts you
install from third-party stashes are third-party code.

### Agents and commands embed user-authored prompts

`akm show agent:<name>` and `akm show command:<name>` return prompt
templates and system prompts that an LLM will execute. A malicious stash
maintainer could write a system prompt that instructs the LLM to read
sensitive files in your working tree and exfiltrate them via the LLM
response. Audit the prompt body the same way you'd audit a script.

### Vaults are plaintext on disk

`akm vault` files are `0o600`-permissioned plaintext at
`<stash>/vaults/<name>.env`. They are protected against other local users
by filesystem permissions but not encrypted at rest. Do not commit vault
files to source control — they are `.gitignore`d in the default stash
layout for that reason. The `akm vault show` / `akm vault list` commands
never echo values; `akm vault load` produces shell-eval output meant to be
piped to `eval`, never displayed.

### Improve / propose / distill send asset content to the configured LLM

`akm improve`, `akm propose`, `akm distill`, `akm reflect`, and `akm
consolidate` send asset frontmatter and body to whatever LLM endpoint is
configured in `~/.config/akm/config.json` (under `llm.endpoint`). If you
have configured a third-party LLM, your asset content goes to that
third-party. Use a local model (`http://localhost:11434` via Ollama, etc.)
for assets containing secrets or private notes.

## Known non-issues

- **`akm` requires Bun or the prebuilt binary** — Node.js is not supported
  in 0.8.0 because Bun-specific APIs are used in hot paths. This is a
  compatibility limitation, not a security risk; the prebuilt binary is a
  Bun-compiled standalone executable.
- **Workflows can read any file the akm process can read.** This is not a
  bug — see "Threat model" above.
- **`bun install -g akm-cli` runs the preinstall hook.** The hook only
  emits an error message and exits non-zero on Node.js; it does not phone
  home or write outside the install directory.
