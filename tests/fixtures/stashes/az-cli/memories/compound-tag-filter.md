---
description: How to write compound AND/OR JMESPath filters for az CLI --query on tagged resources
tags: [az-cli, jmespath, tags, query, filtering]
observed_at: "2026-05-01"
---

az CLI `--query` uses JMESPath. Compound conditions use `&&` (AND) and `||` (OR) inside `[?...]`.

Correct example (resources tagged env=prod AND team=ops):
`az resource list --query "[?tags.env=='prod' && tags.team=='ops']"`

Correct example (either tag matches):
`az resource list --query "[?tags.env=='prod' || tags.env=='staging']"`

Common trap — using Python-style `and`/`or` keywords: `[?tags.env=='prod' and tags.team=='ops']` is invalid JMESPath and returns an empty result silently.

Quoting: single quotes wrap string literals inside the JMESPath expression; the outer double quotes wrap the whole `--query` argument. Swapping them causes a shell parse error.
