---
description: az CLI returns null (not empty string) for missing tag values, which breaks == "" filters
tags: [az-cli, jmespath, tags, null, query]
observed_at: "2026-05-01"
---

When a resource has no value for a tag key, az CLI returns JSON `null`, not `""` (empty string).

Correct check for a missing or absent tag:
`az resource list --query "[?tags.env != null]"` (resources that have the env tag set)

Correct check for resources where the tag is absent:
`az resource list --query "[?tags.env == null]"`

Common trap — writing `tags.env == ""` to find unset tags: this matches nothing because az never returns an empty string for a missing tag; it returns `null`. The filter silently produces an empty list.

Also applies to `tags.key` that exists on the resource but whose value was explicitly set to an empty string via `az tag update`: in that rare case the value is `""`, not `null`, so the two conditions are not equivalent.
