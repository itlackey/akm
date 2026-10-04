Respond only through the provider's native JSON schema. {{FIELD_RULE}}

`frontmatterPatch` must contain exactly `description`, `when_to_use` and `title`; set a field to `null` when it should not change, or to a non-empty single-line string. `title` is the text of a level-1 heading, without the leading `#`; AKM adds it only when the body has none. AKM applies the patch to the source asset, keeps the body itself, and preserves target identity. `confidence` is your honest self-rated quality confidence from 0 to 1. Do not add prose or Markdown fences around the JSON response.
