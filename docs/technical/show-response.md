# ShowResponse Field Reference

`akm show` returns structured output describing an asset. By default, the CLI
emits JSON at `--detail brief`, which keeps only the fields needed to use the
asset. `--detail normal` currently matches `brief`. `--detail full` adds
verbose metadata.

## Default Fields

These fields may appear in the default response shape:

| Field | Type | Description |
| --- | --- | --- |
| `type` | string | Asset type: `script`, `skill`, `command`, `agent`, `knowledge`, or `memory` |
| `name` | string | Asset display name |
| `origin` | string \| null | Owning installed source when the asset came from one |
| `action` | string | Next step the consumer should take |
| `description` | string | Summary when the asset type has one |

## Full-Detail Only Fields

These fields are only emitted with `--detail full`:

| Field | Type | Description |
| --- | --- | --- |
| `schemaVersion` | number | Response schema version (currently `1`) |
| `path` | string | Absolute path to the asset file on disk |
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
| `cwd` | string | no | Working directory for execution when one is known |
| `setup` | string | no | Setup command when a dependency file is detected (e.g. `"bun install"`) |

**Unrecognized extensions:**

| Field | Type | Guaranteed | Description |
| --- | --- | --- | --- |
| `content` | string | yes | Full source code of the script |

Execution hints are resolved in priority order: `.stash.json` fields,
then `@run`/`@setup`/`@cwd` header comment tags, then auto-detection from
the file extension and nearby dependency files. See
[../concepts.md](../concepts.md) for details.

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
| `parameters` | string[] | no | Extracted placeholders such as `ARGUMENTS`, `$1`, or `{{named}}` |

Template bodies may contain `$ARGUMENTS`, `$1`-`$9`, or `{{named}}` placeholders that
should be filled before dispatch.

### agent

| Field | Type | Guaranteed | Description |
| --- | --- | --- | --- |
| `prompt` | string | yes | Full agent prompt content |
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
| `full` (default) | `akm show knowledge:guide` | Full document text |
| `toc` | `akm show knowledge:guide toc` | Formatted table of contents |
| `frontmatter` | `akm show knowledge:guide frontmatter` | Raw YAML frontmatter block |
| `section` | `akm show knowledge:guide section "Auth"` | Content under the named heading |
| `lines` | `akm show knowledge:guide lines 10 30` | Lines 10 through 30 |

### memory

| Field | Type | Guaranteed | Description |
| --- | --- | --- | --- |
| `content` | string | yes | Full text of the memory document |

## Remote Show

When showing `viking://` URIs, the response includes `editable: false` and
content is fetched from the remote OpenViking server. These URIs are not
standard refs but remote resource identifiers.

## Example Responses

A script with known extension (default detail):

```json
{
  "type": "script",
  "name": "deploy.sh",
  "origin": null,
  "action": "Execute the run command below",
  "run": "bash /home/user/akm/scripts/deploy.sh",
  "cwd": "/home/user/akm/scripts",
  "setup": "bun install"
}
```

The same script with `--detail full`:

```json
{
  "schemaVersion": 1,
  "type": "script",
  "name": "deploy.sh",
  "origin": null,
  "action": "Execute the run command below",
  "run": "bash /home/user/akm/scripts/deploy.sh",
  "cwd": "/home/user/akm/scripts",
  "setup": "bun install",
  "path": "/home/user/akm/scripts/deploy.sh",
  "editable": true
}
```

An agent:

```json
{
  "type": "agent",
  "name": "reviewer",
  "origin": null,
  "action": "Dispatch using the prompt below verbatim. Use modelHint and toolPolicy if present.",
  "prompt": "You are a code reviewer...",
  "modelHint": "claude-3-opus",
  "toolPolicy": ["Bash", "Read"]
}
```

A knowledge asset with `toc` view:

```json
{
  "type": "knowledge",
  "name": "api-guide",
  "origin": null,
  "action": "Reference material - read the content below. Use 'toc' view for large documents.",
  "content": "# Table of Contents\n- Authentication\n- Endpoints\n- Error Handling"
}
```

A memory asset:

```json
{
  "type": "memory",
  "name": "project-context",
  "origin": null,
  "action": "Recalled context - read the content below.",
  "content": "# Project Context\nThis project uses Bun as its runtime..."
}
```
