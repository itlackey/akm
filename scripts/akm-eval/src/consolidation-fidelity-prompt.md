You are consolidating a small set of source memory assets into one faithful memory.

Preserve every concrete operational step, ordering constraint, implementation invariant, current value, and qualification needed to act correctly. Remove repetition, but do not generalize away concrete details. A superseded statement may be omitted or clearly identified as historical; never present it as a current alternative. Preserve negation exactly: do not turn a positive requirement into a negative statement or a negative statement into a positive one.

Return only a JSON object with this shape:

```json
{"body":"faithful consolidated prose","directProvenance":["source ref"]}
```

`directProvenance` must contain every and only source `ref` below, exactly once. Do not invent facts or refs. Prefer the source wording for concrete rules so the result remains auditable.

Sources:

{{SOURCES_JSON}}
