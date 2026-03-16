# Kit Maker's Guide

This guide walks through building a kit from scratch and sharing it so others
can install it with `akm add`.

## Step 1: Organize Your Assets

You can organize a kit however you like. akm classifies assets by
**file extension and content**, so directory names are not required to
follow any particular pattern.

That said, using these preferred directory names is an **opt-in convention**
that increases classification confidence during indexing:

```text
my-kit/
  scripts/        # .sh, .ts, .js, .py, .rb, .go, etc.
  skills/         # Directories containing SKILL.md
  commands/       # .md prompt templates (agent frontmatter, $ARGUMENTS)
  agents/         # .md files with model, tools, or toolPolicy frontmatter
  knowledge/      # .md reference documents
  memories/       # .md recalled context fragments
```

These directories are hints, not requirements. A `.sh` file is a script
whether it lives in `scripts/`, `deploy/`, or at the kit root. A `.md` file
with `model` in its frontmatter is an agent definition no matter where you
put it. Nesting is fully supported — `scripts/azure/deploy/run.sh` works
just as well as `scripts/run.sh`. Organize your kit in whatever way makes
sense for your project.

## Step 2: Add Assets

### Scripts

Drop executable scripts into `scripts/`. Supported extensions: `.sh`, `.ts`,
`.js`, `.ps1`, `.cmd`, `.bat`, `.py`, `.rb`, `.go`, `.pl`, `.php`, `.lua`,
and more.

```sh
# scripts/deploy.sh
#!/usr/bin/env bash
set -euo pipefail
echo "Deploying $1..."
```

When an agent runs `akm show script:deploy.sh`, it gets back a `run` command
it can execute directly. Interpreters are auto-detected for a wide range of
extensions (`.sh`, `.ts`, `.js`, `.py`, `.rb`, `.go`, `.pl`, `.php`, `.lua`,
`.r`, `.swift`, `.kt`/`.kts`, `.ps1`, `.cmd`/`.bat`).

If your script has dependencies, add a `package.json` in the script's
directory or a parent. When akm detects a `package.json`, it sets the
working directory to that package root.

### Skills

A skill is a directory containing a `SKILL.md` file. The directory name
becomes the skill name.

```text
skills/
  code-review/
    SKILL.md
```

Write `SKILL.md` as instructions the agent should follow:

```markdown
# Code Review

Review the changed files for bugs, security issues, and style violations.

## Steps

1. Run `git diff --cached` to see staged changes
2. Check each file for common issues
3. Report findings with file paths and line numbers
```

### Commands

Markdown files whose body is a prompt template. Commands follow the
[OpenCode convention](https://opencode.ai/docs/commands/): frontmatter
supports `description`, `model`, and `agent` (dispatch target). The body
can use `$ARGUMENTS` for the full argument string, or `$1`/`$2`/`$3` for
positional arguments:

```markdown
---
description: "Run the release workflow"
model: "claude-sonnet-4-20250514"
agent: build
---
Tag the current commit with the next semantic version, push the tag, and
wait for CI to complete. Target environment: $ARGUMENTS.
```

Commands are automatically detected by content signals -- `agent`
frontmatter or `$ARGUMENTS`/`$1`-`$3` placeholders -- even outside the
`commands/` directory.

### Agents

Markdown files in `agents/`. Frontmatter supports `description`, `model`,
and `tools` fields:

```markdown
---
description: "TypeScript architecture advisor"
model: "claude-sonnet-4-20250514"
tools: ["Read", "Grep", "Glob"]
---
You are a senior TypeScript architect. When reviewing code, focus on
type safety, module boundaries, and dependency management.
```

The `model` field is a hint -- the consuming agent uses it to pick a
compatible model. The `tools` field suggests which tools the agent needs.

### Knowledge

Markdown files in `knowledge/`. These are reference documents agents can
navigate by section:

```markdown
---
title: "API Reference"
---
# Authentication

Use Bearer tokens in the Authorization header.

# Rate Limits

Default: 100 requests per minute per API key.
```

Agents can request just the table of contents (`toc`) or a specific
section (`section "Rate Limits"`) to avoid loading the entire document:

```sh
akm show knowledge:api-guide toc
akm show knowledge:api-guide section "Rate Limits"
```

### Memories

Markdown files in `memories/`. These are recalled context fragments that
provide situational information the agent should consider:

```markdown
---
description: "Team coding standards for TypeScript projects"
---
- Always use strict mode
- Prefer `const` over `let`
- Use named exports, not default exports
```

Memories are surfaced alongside other assets in search results, giving the
agent relevant context without requiring explicit prompts.

## Step 3: Add Metadata

Metadata makes your kit searchable. There are two approaches.

### Automatic (do nothing)

When someone installs your kit and runs `akm index`, metadata is generated
automatically from filenames, code comments, frontmatter, and `package.json`.
This works well for most kits.

### Curated (`.stash.json`)

For better search quality, add a `.stash.json` in any asset type directory:

```json
{
  "entries": [
    {
      "name": "deploy",
      "type": "script",
      "description": "Deploy the application to production",
      "tags": ["deploy", "infrastructure", "ci"],
      "searchHints": [
        "deploy the app",
        "push to production",
        "ship a release"
      ],
      "usage": ["Pass a release tag as the first argument"],
      "filename": "deploy.sh",
      "quality": "curated",
      "source": "manual",
      "confidence": 1.0
    }
  ]
}
```

Good `description`, `tags`, and `searchHints` values make the biggest difference
in search ranking. See [technical/filesystem.md](technical/filesystem.md) for the full field
reference.

## Step 4: Test Locally

Before sharing, install your kit locally to verify everything works:

```sh
# Install from the local directory
akm add ./my-kit

# Check it appears in the list
akm list

# Search for your assets
akm search "deploy"

# Show an asset to verify the output
akm show script:deploy.sh
```

## Sharing on GitHub

1. Push your kit to a GitHub repository.

2. Add the `akm` topic to your repo so it appears in registry search:

   ```sh
   gh repo edit --add-topic akm
   ```

   Or add it from the repository settings page under "Topics".

3. Others can now install it:

   ```sh
   akm add github:your-username/my-kit
   ```

4. To pin a version, create a GitHub release. When a release exists, `akm add`
   uses the latest release tarball. Otherwise it uses the default branch.

   ```sh
   # Install a specific tag
   akm add github:your-username/my-kit#v1.0.0
   ```

## Sharing on npm

1. Add a `package.json` with `"akm"` in the keywords:

   ```json
   {
     "name": "@your-scope/my-kit",
     "version": "1.0.0",
     "description": "Scripts and skills for deployment workflows",
     "keywords": ["akm"]
   }
   ```

2. If your repo contains files that should not be part of the kit (source
   code, tests, CI config), use `akm.include` to declare which paths
   to ship:

   ```json
   {
     "name": "@your-scope/my-kit",
     "version": "1.0.0",
     "keywords": ["akm"],
     "akm": {
       "include": ["scripts", "skills", "knowledge"]
     }
   }
   ```

   Paths are relative to the `package.json`. Only the listed directories and
   files are copied into the install cache. The `.git` directory is always
   excluded.

3. Publish to npm:

   ```sh
   npm publish --access public
   ```

4. Others can now install it:

   ```sh
   akm add @your-scope/my-kit
   ```

## Submitting to the Registry

CLI-based kit submission is planned for a future release. To submit a kit now, open a pull request directly against the [akm-registry](https://github.com/itlackey/akm-registry) repository.

## Sharing on a Network Directory

For teams that want to share assets without publishing to a registry, use
search paths.

1. Place your kit on a shared filesystem (NFS, SMB, cloud-synced folder):

   ```text
   /mnt/shared/team-kit/
     scripts/
     skills/
     commands/
   ```

2. Each team member mounts it in their config:

   ```sh
   akm config set searchPaths '["/mnt/shared/team-kit"]'
   ```

   Or add it directly to `~/.config/akm/config.json`:

   ```json
   {
     "searchPaths": ["/mnt/shared/team-kit"]
   }
   ```

3. Assets from the search path appear in search results immediately --
   no `akm add` needed. To fork an asset into the primary stash, use clone:

   ```sh
   akm clone script:deploy.sh
   ```

   Or clone directly to a project directory with `--dest`:

   ```sh
   akm clone script:deploy.sh --dest ./my-project/.claude
   ```

You can mount multiple directories. They are searched in the order listed,
after the working stash.

## Kit Structure Tips

- **Keep it focused.** A kit with 5 great scripts is more useful than one with
  50 mediocre ones.

- **Write good descriptions.** The `description` field (in frontmatter,
  `.stash.json`, or `package.json`) is the primary signal for search ranking.

- **Use frontmatter in markdown assets.** A `description` in frontmatter is
  extracted automatically with high confidence (0.9), making your commands,
  agents, and knowledge documents more discoverable without needing a
  `.stash.json`.

- **Test the search experience.** After installing your kit, search for it
  using the terms you expect users to try. If results are poor, improve the
  descriptions, tags, and searchHints.

- **Document usage in the asset itself.** For skills, put the instructions in
  `SKILL.md`. For commands, put the workflow in the markdown body. The agent
  reads these directly.

- **Version your kit.** Use npm versions or GitHub releases so users can pin
  to a known-good state with `akm add npm:pkg@1.2.3` or
  `akm add github:owner/repo#v1.2.3`.
