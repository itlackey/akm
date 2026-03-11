# openRef Format

An openRef is a compact string that uniquely identifies an asset. It is the
primary way to reference assets in `akm show`, search results, and
cross-asset links.

## Format

```
[origin//]type:name
```

| Part | Required | Description |
| --- | --- | --- |
| `origin` | no | Identifies which installed kit the asset belongs to. Separated from the rest of the ref by `//`. |
| `type` | yes | The asset type. One of: `script`, `skill`, `command`, `agent`, `knowledge`. |
| `name` | yes | The asset filename or path relative to the type directory. |

## Types

The `type` segment must be one of the five primary asset types:

| Type | Purpose |
| --- | --- |
| `script` | Executable scripts with generated run commands |
| `skill` | Structured skill packages (SKILL.md) |
| `command` | Prompt templates with dispatch targets |
| `agent` | Agent definitions with model hints |
| `knowledge` | Reference documents with section navigation |

`tool` is accepted as a transparent alias for `script`. Both `tool:deploy.sh`
and `script:deploy.sh` resolve to the same asset. All output normalizes
`tool` to `script`.

## Name

The `name` is the asset's filename (or path relative to the type directory
when the asset is nested). Extensions are included for file-based types:

- `script:deploy.sh`
- `knowledge:api-guide.md`
- `agent:reviewer.md`

For skills, the name is the skill directory name (the directory containing
`SKILL.md`):

- `skill:code-review`

## Origin

The `origin` prefix is optional. When present, it identifies the installed
kit that owns the asset. This is useful when multiple kits provide assets
with the same name.

The origin is separated from the type:name portion by `//`:

```
mykit//agent:reviewer
npm:@scope/pkg//script:deploy.sh
github:owner/repo//knowledge:guide.md
```

When no origin is specified, assets are resolved from all stash sources in
priority order (primary stash, search paths, installed kits). The first
match wins.

## Version

There is no version qualifier in openRefs. Versions are resolved at the
stash layer:

- npm packages use semver resolution
- Git sources use tags, branches, or commits
- Local sources use whatever is on disk

The installed version is tracked in config and updated via `akm update`.

## Parsing Rules

To parse an openRef:

1. Split on `//`. If the split produces two parts, the left side is the
   `origin` and the right side continues to step 2. If there is no `//`,
   the entire string continues to step 2 with no origin.
2. Split the remaining string on the first `:`. The left side is the `type`
   and the right side is the `name`.
3. Normalize `tool` to `script` if the type is `tool`.

## Examples

| Ref | Origin | Type | Name |
| --- | --- | --- | --- |
| `script:deploy.sh` | (none) | script | deploy.sh |
| `skill:code-review` | (none) | skill | code-review |
| `knowledge:api-guide.md` | (none) | knowledge | api-guide.md |
| `agent:reviewer.md` | (none) | agent | reviewer.md |
| `command:release.md` | (none) | command | release.md |
| `tool:lint.sh` | (none) | script | lint.sh |
| `mykit//agent:reviewer` | mykit | agent | reviewer |
| `npm:@scope/pkg//script:deploy.sh` | npm:@scope/pkg | script | deploy.sh |

## Usage

openRefs appear in two main contexts:

1. **Search results** -- Each local hit includes an `openRef` field. Pass it
   directly to `akm show`:

   ```sh
   akm show script:deploy.sh
   ```

2. **Cross-asset references** -- Commands can reference agents by name
   (via the `agent` frontmatter key), and agents can reference tools. These
   are not full openRefs but follow the same type:name pattern.
