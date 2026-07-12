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
[`docs/data-and-telemetry.md`](docs/data-and-telemetry.md) for the on-disk
inventory.

Several akm surfaces execute user-controlled code or data with the full
permissions of the akm process. These are documented design decisions, not
bugs, but you should be aware of them:

### Workflows execute shell commands with full environment access

Workflow steps run in your shell with your PATH and your environment
variables — including any secrets you have exported or loaded via
`akm env run` / `akm secret run`. **Only add workflow sources you trust.** See
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

### Environment and secret assets are plaintext on disk

`env` and `secret` assets are owner-permissioned plaintext under `<stash>/env/`
and `<stash>/secrets/`. They are protected against other local users by
filesystem permissions but are not encrypted at rest. Do not commit these
files to source control. Normal `akm env` and `akm secret` output never echoes
values; materialize values only at the command boundary with `akm env run`,
`akm secret run`, or `akm secret path`.

### Improve / propose / distill send asset content to the configured LLM

`akm improve`, `akm propose`, `akm distill`, `akm reflect`, and `akm
consolidate` can send asset frontmatter and body to the named LLM engine selected
by the command, strategy, or current defaults. LLM connections live under
`engines.<name>` in `~/.config/akm/config.json`. If you configure a third-party
LLM, your asset content goes to that third party. Use a local engine endpoint
(for example, `http://localhost:11434/v1/chat/completions` via Ollama) for assets
containing secrets or private notes.

## Known non-issues

- **`akm` requires Bun, Node.js >= 20.12, or the prebuilt binary.** Older
  Node.js versions are unsupported because required runtime APIs are missing.
  This is a compatibility limitation, not a security risk.
- **Workflows can read any file the akm process can read.** This is not a
  bug — see "Threat model" above.
- **Installing `akm-cli` runs the preinstall hook.** The hook only validates
  the runtime version and exits non-zero when it is unsupported; it does not
  phone home or write outside the install directory.
