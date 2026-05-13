---
description: "Review a codebase against design patterns and coding standards"
tags:
  - review
  - refactor
  - code-quality
searchHints:
  - audit code for patterns
  - review project architecture
  - find refactoring needs
quality: curated
---

# Review Codebase for Refactoring

Execute an exhaustive codebase refactoring review using the skill methodology.

## Steps

### 1. Prepare the Codebase

Add and index the target codebase if not already available:

```sh
# If codebase is not yet added
akm add /path/to/project --name project-source
akm index

# Search to verify
akm search "project_name" --source stash
```

### 2. Run the Review

Execute the full review by loading the skill:

```sh
# Load and follow the skill
akm show skill:codebase-refactor-review

# Or use the agent for interactive review
akm show agent:code-refactor-reviewer
```

The skill contains the complete methodology. Follow its checklist exactly and consult references/ for detailed information on any topic.

### 3. Export Findings

Save the review results as memories with appropriate tags:

```sh
akm remember "Refactor review for {{project_name}}: {{critical}} critical, {{warning}} warnings, {{suggestion}} suggestions" --tag review --tag refactor --tag {{project_name}}
```

### 4. Track Refactoring Tasks

Create actionable memories for critical findings:

```sh
akm remember "Refactor {{file_path}} - {{pattern_name}} violation" --tag refactor --tag task --priority high
```

## Expected Output

A structured report with four deliverables as specified in the skill:

1. **Executive Summary** — Health score, finding counts, top priorities
2. **Full Findings** — Every issue with file/line references in template format
3. **Design Pattern Map** — What's used well vs. what's missing
4. **Refactoring Roadmap** — Prioritized by impact × effort

## See Also

- `skill:codebase-refactor-review` — Primary methodology
- `skill:codebase-refactor-review/references/` — Detailed reference guides
- `skill:codebase-refactor-review/references/index.md` — Topic index