# ShowResponse Field Reference

`akm show` returns structured JSON describing an asset. Every response
includes a set of common fields. Additional fields vary by asset type.

## Common Fields

These fields are present on every ShowResponse regardless of type:

| Field | Type | Description |
| --- | --- | --- |
| `schemaVersion` | number | Response schema version (currently `1`) |
| `type` | string | Asset type: `script`, `skill`, `command`, `agent`, or `knowledge` |
| `name` | string | Asset display name (usually the filename without extension) |
| `path` | string | Absolute path to the asset file on disk |

## Optional Common Fields

These fields may appear on any asset type depending on context:

| Field | Type | Description |
| --- | --- | --- |
| `registryId` | string | Registry identifier for assets from installed kits |
| `editable` | boolean | Whether the asset is safe to edit in place. `false` for cache-managed files from installed kits. Verbose-only. |
| `editHint` | string | Actionable guidance when `editable` is false (e.g. "use `akm clone` to make an editable copy"). Verbose-only. |

## Per-Type Fields

### script

Scripts with a known extension (`.sh`, `.ts`, `.py`, etc.) return execution
hints. Scripts with unrecognized extensions fall back to raw content.

**Known extensions:**

| Field | Type | Guaranteed | Description |
| --- | --- | --- | --- |
| `run` | string | yes | Full run command (e.g. `"bash /path/to/deploy.sh"`) |
| `cwd` | string | yes | Working directory for execution |
| `setup` | string | no | Setup command when a dependency file is detected (e.g. `"bun install"`) |

**Unrecognized extensions:**

| Field | Type | Guaranteed | Description |
| --- | --- | --- | --- |
| `content` | string | yes | Full source code of the script |

Execution hints are resolved in priority order: `.stash.json` fields,
then `@run`/`@setup`/`@cwd` header comment tags, then auto-detection from
the file extension and nearby dependency files. See
[concepts.md](concepts.md) for details.

### skill

| Field | Type | Guaranteed | Description |
| --- | --- | --- | --- |
| `content` | string | yes | Full text of the SKILL.md file |

### command

| Field | Type | Guaranteed | Description |
| --- | --- | --- | --- |
| `template` | string | yes | The command template body (markdown content after frontmatter extraction) |
| `description` | string | no | Summary from frontmatter `description` key |
| `modelHint` | unknown | no | Preferred model from frontmatter `model` key |
| `agent` | string | no | Dispatch target agent from frontmatter `agent` key (OpenCode convention) |

Template bodies may contain `$ARGUMENTS` or `$1`-`$3` placeholders that
should be filled before dispatch.

### agent

| Field | Type | Guaranteed | Description |
| --- | --- | --- | --- |
| `prompt` | string | yes | Full agent prompt content, prefixed with a dispatch compliance notice |
| `description` | string | no | Summary from frontmatter `description` key |
| `modelHint` | unknown | no | Preferred model from frontmatter `model` key |
| `toolPolicy` | string, string[], or object | no | Tool access policy from frontmatter `tools` key |

The `toolPolicy` field can take several forms: a single tool name
(`"Bash"`), a list of tool names (`["Bash", "Read"]`), or a structured
policy object (`{ "read": "allow", "write": "deny" }`).

### knowledge

Knowledge assets support multiple view modes, controlled by a positional
argument after the ref. All modes return their result in the `content`
field.

| Field | Type | Guaranteed | Description |
| --- | --- | --- | --- |
| `content` | string | yes | Document content (format depends on the view mode) |

**View modes:**

| Mode | Command | Content |
| --- | --- | --- |
| `full` (default) | `akm show knowledge:guide.md` | Full document text |
| `toc` | `akm show knowledge:guide.md toc` | Formatted table of contents |
| `frontmatter` | `akm show knowledge:guide.md frontmatter` | Raw YAML frontmatter block |
| `section` | `akm show knowledge:guide.md section "Auth"` | Content under the named heading |
| `lines` | `akm show knowledge:guide.md lines 10 30` | Lines 10 through 30 |

## Example Responses

A script with known extension:

```json
{
  "schemaVersion": 1,
  "type": "script",
  "name": "deploy",
  "path": "/home/user/akm/scripts/deploy.sh",
  "run": "bash /home/user/akm/scripts/deploy.sh",
  "cwd": "/home/user/akm/scripts",
  "setup": "bun install"
}
```

An agent:

```json
{
  "schemaVersion": 1,
  "type": "agent",
  "name": "reviewer",
  "path": "/home/user/akm/agents/reviewer.md",
  "prompt": "Dispatching prompt must include the agent's full prompt content verbatim; summaries are non-compliant. \n\nYou are a code reviewer...",
  "modelHint": "claude-3-opus",
  "toolPolicy": ["Bash", "Read"]
}
```

A knowledge asset with `toc` view:

```json
{
  "schemaVersion": 1,
  "type": "knowledge",
  "name": "api-guide",
  "path": "/home/user/akm/knowledge/api-guide.md",
  "content": "# Table of Contents\n- Authentication\n- Endpoints\n- Error Handling"
}
```
