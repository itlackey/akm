Respond only through the provider's native JSON schema. {{FIELD_RULE}}

`content` must contain the complete improved markdown body only, without YAML frontmatter. `frontmatterPatch` must contain exactly `description` and `when_to_use`; set either field to `null` when it should not change, or to a non-empty string when adding or correcting it. AKM merges that narrow patch with the source frontmatter and preserves target identity itself. `confidence` is your honest self-rated quality confidence from 0 to 1. Do not add prose or Markdown fences around the JSON response.
