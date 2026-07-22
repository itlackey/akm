Respond with exactly this plain-text frame, with no prose or code fence around it:

{{REF_LINE}}AKM_REFLECT_CONFIDENCE: <number from 0 to 1>
AKM_REFLECT_FRONTMATTER_PATCH: {"description": null, "when_to_use": null}
AKM_REFLECT_CONTENT_BEGIN
<complete improved markdown body>
AKM_REFLECT_CONTENT_END

The first begin marker and final end marker delimit the body; marker lines between them are literal content. Put the complete markdown body between those outer markers. Quotes, Markdown fences, and backslashes inside the body are literal content; do not JSON-escape them. Emit the body only, without YAML frontmatter, because AKM preserves and merges the source frontmatter itself.

The frontmatter patch must be a one-line JSON object with exactly `description` and `when_to_use`. Keep a field `null` when it should not change. Supply a non-empty string only when adding or correcting that field; AKM merges those values through its existing sanitizer.
