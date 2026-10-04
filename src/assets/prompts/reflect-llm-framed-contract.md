Respond with exactly this plain-text frame, with no prose or code fence around it:

{{REF_LINE}}AKM_REFLECT_CONFIDENCE: <number from 0 to 1>
AKM_REFLECT_FRONTMATTER_PATCH: {"description": null, "when_to_use": null, "title": null}

The frontmatter patch must be a one-line JSON object with exactly `description`, `when_to_use` and `title`. Keep a field `null` when it should not change; otherwise give a non-empty single-line string. `title` is the text of a level-1 heading, without the leading `#`; AKM adds it only when the body has none. AKM applies the patch to the source asset and keeps the body itself.
