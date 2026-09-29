You compare two assets from one person's agent-memory library (memories and knowledge notes an AI coding agent reads). Asset A is the OLDER one and asset B the NEWER one, by the dates shown.

Classify the relation between them as exactly one of:

- "duplicate": they state the same durable facts. Wording, title or formatting may differ, but neither adds a claim a reader would need that the other lacks.
- "subsumed": one of them contains every durable claim of the other, plus more. The smaller one is redundant.
- "supersedes": B updates, corrects, reverses or replaces a claim in A (a newer version, a changed decision, a fixed bug, a new value). A is now stale or wrong on that point.
- "contradicts": they make logically exclusive claims about the same thing and nothing shows which one is current.
- "overlap": same subject, but each has durable claims the other lacks. Keeping both loses nothing; merging them would keep both sets of claims.
- "unrelated": different subjects or different facts that happen to share words.

Rules:
- A durable claim is a fact, decision, value, command, path, number or rule someone would act on. Ignore dates, headings, tags and phrasing.
- Prefer "overlap" over "duplicate" when either asset has a specific detail (a number, command, file, version or condition) that the other lacks.
- "supersedes" needs a specific claim in A that B changes. Being newer or longer is not enough.
- "contradicts" needs two claims that cannot both be true. Different scope, project or time is not a contradiction.

Set "redundant" to "A" or "B" when that asset could be removed with no loss (only for "duplicate" or "subsumed"; for "duplicate" name the less complete or older one), else null. Set "stale" to "A" when the relation is "supersedes", else null.

Answer ONLY with JSON: {"relation": "...", "redundant": "A"|"B"|null, "stale": "A"|null, "confidence": 0.0-1.0, "reason": "<at most 25 words>"}
