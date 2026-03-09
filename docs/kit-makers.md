# Kit Maker's Guide

This guide walks through building a kit from scratch and sharing it so others
can install it with `akm add`.

## Step 1: Create the Directory Structure

A kit is a directory with one or more asset type subdirectories:

```text
my-kit/
  tools/
  skills/
  commands/
  agents/
  knowledge/
  scripts/
```

You only need the directories for the asset types you are shipping. A kit
with just `tools/` and a `knowledge/` doc is perfectly valid.

## Step 2: Add Assets

### Tools

Drop executable scripts into `tools/`. Supported extensions: `.sh`, `.ts`,
`.js`, `.ps1`, `.cmd`, `.bat`.

```sh
# tools/deploy.sh
#!/usr/bin/env bash
set -euo pipefail
echo "Deploying $1..."
```

When an agent runs `akm show tool:deploy.sh`, it gets back a `runCmd` it can
execute directly.

If your tool has dependencies, add a `package.json` in the tool's directory
or a parent. When akm detects a `package.json`, it sets the working directory
to that package root.

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

Markdown files in `commands/`. Use YAML frontmatter for the description:

```markdown
---
description: "Run the release workflow"
---
Tag the current commit with the next semantic version, push the tag, and
wait for CI to complete.
```

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

Agents can request just the table of contents (`--view toc`) or a specific
section (`--view section --heading "Rate Limits"`) to avoid loading the
entire document.

### Scripts

General-purpose scripts in `scripts/`. Supports a wide range of extensions:
`.sh`, `.ts`, `.js`, `.py`, `.rb`, `.go`, `.pl`, `.php`, `.lua`, `.r`,
`.swift`, `.kt`, and more.

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
      "type": "tool",
      "description": "Deploy the application to production",
      "tags": ["deploy", "infrastructure", "ci"],
      "intents": [
        "deploy the app",
        "push to production",
        "ship a release"
      ],
      "usage": ["Pass a release tag as the first argument"],
      "entry": "deploy.sh",
      "quality": "curated",
      "source": "manual",
      "confidence": 1.0
    }
  ]
}
```

Good `description`, `tags`, and `intents` values make the biggest difference
in search ranking. See [filesystem.md](filesystem.md) for the full field
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
akm show tool:deploy.sh
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
     "description": "Tools and skills for deployment workflows",
     "keywords": ["akm"]
   }
   ```

2. If your repo contains files that should not be part of the kit (source
   code, tests, CI config), use `agentikit.include` to declare which paths
   to ship:

   ```json
   {
     "name": "@your-scope/my-kit",
     "version": "1.0.0",
     "keywords": ["akm"],
     "agentikit": {
       "include": ["tools", "skills", "knowledge"]
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

## Sharing on a Network Directory

For teams that want to share assets without publishing to a registry, use
mounted stash directories.

1. Place your kit on a shared filesystem (NFS, SMB, cloud-synced folder):

   ```text
   /mnt/shared/team-kit/
     tools/
     skills/
     commands/
   ```

2. Each team member mounts it in their config:

   ```sh
   akm config set mountedStashDirs '["/mnt/shared/team-kit"]'
   ```

   Or add it directly to `~/.config/agentikit/config.json`:

   ```json
   {
     "mountedStashDirs": ["/mnt/shared/team-kit"]
   }
   ```

3. Assets from the mounted directory appear in search results immediately --
   no `akm add` needed. Mounted stash dirs are read-only; to edit an asset,
   clone it into the working stash:

   ```sh
   akm clone tool:deploy.sh
   ```

You can mount multiple directories. They are searched in the order listed,
after the working stash.

## Kit Structure Tips

- **Keep it focused.** A kit with 5 great tools is more useful than one with
  50 mediocre ones.

- **Write good descriptions.** The `description` field (in frontmatter,
  `.stash.json`, or `package.json`) is the primary signal for search ranking.

- **Use frontmatter in markdown assets.** A `description` in frontmatter is
  extracted automatically with high confidence (0.9), making your commands,
  agents, and knowledge documents more discoverable without needing a
  `.stash.json`.

- **Test the search experience.** After installing your kit, search for it
  using the terms you expect users to try. If results are poor, improve the
  descriptions, tags, and intents.

- **Document usage in the asset itself.** For skills, put the instructions in
  `SKILL.md`. For commands, put the workflow in the markdown body. The agent
  reads these directly.

- **Version your kit.** Use npm versions or GitHub releases so users can pin
  to a known-good state with `akm add npm:pkg@1.2.3` or
  `akm add github:owner/repo#v1.2.3`.
