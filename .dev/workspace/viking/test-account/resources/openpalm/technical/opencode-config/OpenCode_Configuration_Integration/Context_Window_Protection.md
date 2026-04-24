## Context Window Protection

The assistant has access to API keys and tokens at runtime (they are in
its process environment). When those credentials appear in tool output
(error messages, debug traces, env dumps), they enter the LLM context
window. Five layers prevent this:

### Layer 1: Shell Wrapper (varlock-shell)

OpenCode resolves its bash tool shell via the `$SHELL` environment
variable. The entrypoint sets `SHELL=/usr/local/bin/varlock-shell`, a
wrapper script that runs all bash tool commands through `varlock run`.
Varlock reads the redaction schema (`.env.schema` at
`/usr/local/etc/varlock/`) to identify sensitive variable names and
redacts their values from command output before OpenCode passes the
output to the LLM.

**Graceful fallback:** If `varlock` is not installed or the schema file
is missing (e.g. older image, custom builds), `varlock-shell` falls back
to plain `/bin/bash` with no redaction.

**Files:**
- `core/assistant/varlock-shell.sh` -- the wrapper script
- `core/assistant/entrypoint.sh` -- sets `SHELL` before starting OpenCode

### Layer 2: Provider Key Isolation

The entrypoint's `maybe_unset_unused_provider_keys()` function removes
LLM provider API keys that are not needed for the configured provider.
Only the active provider's key remains in the environment, limiting the
blast radius if the assistant process is compromised.

### Layer 3: Permission Deny on Credential Files

The system config (`opencode.jsonc`) includes `permission.read` deny
rules that block the assistant from reading OpenCode's own credential
stores:

- `/home/opencode/.local/share/opencode/auth.json` -- session tokens
- `/home/opencode/.local/share/opencode/mcp-auth.json` -- MCP auth tokens

These files contain tokens that the assistant never needs to read
directly. The deny rules ensure they cannot enter the context window
through OpenCode's file read tool.

### Layer 4: Varlock Runtime Redaction

When varlock is available, the entrypoint wraps the OpenCode process
with `varlock run`, which applies runtime redaction to stdout/stderr
based on the `.env.schema` at `/usr/local/etc/varlock/`.

### Layer 5: MCP Server Wrapping (planned)

Future layer — wrap MCP server communication for additional redaction.

---