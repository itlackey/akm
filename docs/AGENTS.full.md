# akm CLI — Full Reference

You have access to a searchable library of scripts, skills, commands, agents, and knowledge documents via `akm`. Search the stash first before writing something from scratch.

## Search

```sh
akm search "<query>"                          # Search local stash
akm search "<query>" --type skill             # Filter by asset type
akm search "<query>" --source both            # Search local stash and registries
akm search "<query>" --source registry        # Search registries only
akm search "<query>" --limit 10               # Limit results
akm search "<query>" --detail full            # Include scores, paths, timing
```

| Flag | Values | Default |
| --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `script`, `any` | `any` |
| `--source` | `local`, `registry`, `both` | `local` |
| `--limit` | number | `20` |
| `--format` | `json`, `text`, `yaml` | `json` |
| `--detail` | `brief`, `normal`, `full` | `brief` |

## Show

Display an asset by ref. Knowledge assets support view modes as positional arguments.

```sh
akm show script:deploy.sh                     # Show script (returns run command)
akm show skill:code-review                    # Show skill (returns full content)
akm show command:release                      # Show command (returns template)
akm show agent:architect                      # Show agent (returns system prompt)
akm show knowledge:guide toc                  # Table of contents
akm show knowledge:guide section "Auth"       # Specific section
akm show knowledge:guide lines 10 30          # Line range
```

| Type | Key fields returned |
| --- | --- |
| script | `run`, `setup`, `cwd` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description`, `parameters` |
| agent | `prompt`, `description`, `modelHint`, `toolPolicy` |
| knowledge | `content` (with view modes: `full`, `toc`, `frontmatter`, `section`, `lines`) |

## Install & Manage Kits

```sh
akm add <ref>                                 # Install a kit
akm add @scope/kit                            # From npm
akm add owner/repo                            # From GitHub
akm add ./path/to/local/kit                   # From local directory
akm list                                      # List installed kits
akm remove <target>                           # Remove by id or ref
akm update --all                              # Update all installed kits
akm update <target> --force                   # Force re-download
```

## Clone

Copy an asset to the working stash or a custom destination for editing.

```sh
akm clone <ref>                               # Clone to working stash
akm clone <ref> --name new-name               # Rename on clone
akm clone <ref> --dest ./project/.claude       # Clone to custom location
akm clone <ref> --force                       # Overwrite existing
akm clone "npm:@scope/pkg//script:deploy.sh"  # Clone from remote package
```

When `--dest` is provided, `akm init` is not required first.

## Registries

```sh
akm registry list                             # List configured registries
akm registry add <url>                        # Add a registry
akm registry add <url> --name my-team         # Add with label
akm registry add <url> --provider skills-sh   # Specify provider type
akm registry remove <url-or-name>             # Remove a registry
akm registry search "<query>"                 # Search all registries
akm registry search "<query>" --assets        # Include asset-level results
```

## Configuration

```sh
akm config list                               # Show current config
akm config get <key>                          # Read a value
akm config set <key> <value>                  # Set a value
akm config unset <key>                        # Remove a key
akm config path --all                         # Show all config paths
```

## Other Commands

```sh
akm init                                      # Initialize stash directory
akm index                                     # Rebuild search index
akm index --full                              # Full reindex
akm sources                                   # List stash search paths
akm upgrade                                   # Upgrade akm binary
akm upgrade --check                           # Check for updates
akm hints                                     # Print this reference
```

## Output Control

All commands accept `--format` and `--detail` flags:

- `--format json` (default) — structured JSON
- `--format text` — human-readable plain text
- `--format yaml` — YAML output
- `--detail brief` (default) — compact output
- `--detail normal` — adds tags, refs, origins
- `--detail full` — includes scores, paths, timing, debug info

Run `akm -h` or `akm <command> -h` for per-command help.
