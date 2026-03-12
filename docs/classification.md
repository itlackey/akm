# Classification System

akm uses a specificity-based classification system to determine what type
each file is and how it should be rendered. This document describes the
specificity ranges, built-in matchers, and the content signals that drive
classification.

## Overview

When akm walks a stash directory, every file is passed through a set of
**matchers**. Each matcher inspects the file and either returns a match
(with a type, specificity score, and renderer name) or abstains. The match
with the highest specificity wins. Ties are broken by registration order:
later-registered matchers win.

The winning match determines two things:

1. **Type** -- What kind of asset this file is (`script`, `skill`,
   `command`, `agent`, or `knowledge`).
2. **Renderer** -- How the asset is presented in `akm show` and search
   results.

## Specificity Ranges

Specificity scores are divided into defined ranges. Each range corresponds
to a confidence level and detection strategy:

| Range | Level | Strategy |
| --- | --- | --- |
| 1-5 | Fallback | Extension-based detection. Lowest confidence. Works in any directory. |
| 6-15 | Structural | Directory-based detection. The file's directory matches a known type name (e.g. `scripts/`, `agents/`). |
| 16-25 | Content-definitive | Frontmatter or body content analysis. Highest confidence for built-in matchers. |
| 26+ | Reserved | Reserved for user-registered or plugin matchers. |

Higher specificity always wins. A content-based match at 20 overrides a
directory-based match at 15, which in turn overrides an extension-only
match at 3.

## Built-in Matchers

Four matchers ship with akm. They are evaluated for every file during
walking and indexing.

### Extension Matcher (specificity: 3)

Classifies files purely by file extension. This is the baseline: every file
with a known extension gets a type, regardless of directory.

- Files with script extensions (`.sh`, `.ts`, `.js`, `.py`, `.rb`, `.go`,
  etc.) are classified as `script`.
- `SKILL.md` files are classified as `skill`.
- `.md` files are **not** handled here -- they are deferred to the smart
  markdown matcher for richer analysis.

### Directory Matcher (specificity: 10)

Boosts specificity when the first ancestor directory segment from the stash
root matches a known type name:

- `scripts/` or `tools/` -- script (for files with known script extensions)
- `skills/` -- skill (for `SKILL.md` files)
- `commands/` -- command (for `.md` files)
- `agents/` -- agent (for `.md` files)
- `knowledge/` -- knowledge (for `.md` files)

### Parent-Dir Hint Matcher (specificity: 15)

Similar to the directory matcher but uses the **immediate parent directory**
name rather than the first ancestor. This provides higher confidence for
nested structures where the immediate parent carries a strong naming
convention (e.g. `my-project/agents/planning.md`).

Same directory-to-type mappings as the directory matcher.

### Smart Markdown Matcher (specificity: 20 / 18 / 8 / 5)

Inspects `.md` file frontmatter and body content for type-specific signals.
Returns different specificity levels depending on the strength of the
signal:

| Specificity | Signal | Classified As |
| --- | --- | --- |
| 20 | `tools` or `toolPolicy` in frontmatter | agent |
| 18 | `agent` in frontmatter, or `$ARGUMENTS`/`$1`-`$3` in body | command |
| 8 | `model` alone in frontmatter | agent (weak) |
| 5 | Any `.md` with no other signals | knowledge (fallback) |

**Agent-exclusive signals** (`tools`, `toolPolicy`) at specificity 20
override everything else. These keys unambiguously identify an agent
definition.

**Command signals** at specificity 18 override directory hints (10/15).
The `agent` frontmatter key names an OpenCode dispatch target, and
`$ARGUMENTS`/`$1`-`$3` placeholders are definitively command template
patterns.

**Weak agent signal** (`model` alone) at specificity 8 loses to directory
hints. A `.md` file with only `model` in its frontmatter that lives in
`commands/` stays classified as a command (directory matcher returns 10 or
15, which beats 8).

**Knowledge fallback** at specificity 5 catches any `.md` file that has no
agent or command signals. This is slightly above the extension matcher (3)
so that markdown always gets classified, but it yields to directory hints.

## Frozen Frontmatter Vocabulary

The following frontmatter keys are recognized by the classification system
and are frozen as of schema version 1:

| Key | Classification Signal |
| --- | --- |
| `tools` | Agent-exclusive (specificity 20) |
| `toolPolicy` | Agent-exclusive (specificity 20) |
| `agent` | Command signal (specificity 18) |
| `model` | Weak agent signal (specificity 8) |

Other frontmatter keys (e.g. `description`) are used by renderers but do
not affect classification.

## Template Placeholders

Command templates use placeholders from the OpenCode convention:

| Placeholder | Purpose |
| --- | --- |
| `$ARGUMENTS` | Full argument string passed to the command |
| `$1`, `$2`, `$3` | Positional arguments |

The presence of any of these placeholders in a `.md` file body triggers
command classification at specificity 18.

## Renderers

Each asset type has a dedicated renderer that determines how the asset is
presented in `akm show` and how search hits are enriched:

| Renderer | Asset Type | Output |
| --- | --- | --- |
| `script-source` | script | `run` command for known extensions; raw source for others |
| `skill-md` | skill | Full SKILL.md content |
| `command-md` | command | Extracted template, description, model hint, dispatch target |
| `agent-md` | agent | Prompt content plus `action`, model hint, and tool policy |
| `knowledge-md` | knowledge | Content with view modes (full, toc, section, lines, frontmatter) |

## Extensibility

Custom matchers and renderers can be registered in source to support new
asset types or override built-in behavior. Key rules:

- Register custom matchers at specificity 26 or higher to reliably override
  all built-in matchers.
- Later registrations win ties at the same specificity, so a custom matcher
  at specificity 20 overrides the built-in smart markdown matcher at 20.
- Custom renderers replace any existing renderer with the same name.

See `src/matchers.ts` and `src/renderers.ts` for implementation examples.

## Classification in Practice

A few examples showing how specificity resolution works:

| File | Extension | Directory | Frontmatter | Winning Matcher | Type |
| --- | --- | --- | --- | --- | --- |
| `scripts/deploy.sh` | .sh | scripts/ | -- | parentDirHint (15) | script |
| `random/deploy.sh` | .sh | random/ | -- | extension (3) | script |
| `agents/reviewer.md` | .md | agents/ | `tools: [Bash]` | smartMd (20) | agent |
| `commands/release.md` | .md | commands/ | `agent: coder` | smartMd (18) | command |
| `commands/hint.md` | .md | commands/ | `model: gpt-4` | parentDirHint (15) | command |
| `docs/guide.md` | .md | docs/ | -- | smartMd (5) | knowledge |
