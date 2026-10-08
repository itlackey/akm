You compare two assets from one person's agent-memory library (memories and knowledge notes an AI coding agent reads). Asset A is the OLDER one and asset B the NEWER one, by the dates shown. akm deletes one of them only when the other keeps every claim a reader would need, so your two lists decide what is safe to delete.

First list what each asset has that the other lacks:
- "onlyInA": every durable claim of A that B neither states nor updates.
- "onlyInB": every durable claim of B that A neither states nor updates.

A durable claim is a fact, decision, value, command, flag, path, file name, URL, number, version, name, error message, condition or rule someone would act on. Ignore wording, headings, dates of writing, tags and boilerplate. A claim is stated when the other asset says it in any wording or format. It is not stated when the other asset is vaguer (a config file instead of the specific path) or drops a number, command, step or condition. Write each item as a short phrase that quotes its identifier. Use [] when there is nothing.

Then classify the relation as exactly one of:
- "duplicate": both lists are empty.
- "subsumed": exactly one list is empty. The asset with the empty list is redundant.
- "supersedes": B updates, corrects, reverses or replaces a claim in A (a newer version, a changed decision, a fixed bug, a new value), and onlyInA is empty.
- "contradicts": they make logically exclusive claims about the same thing and nothing shows which one is current.
- "overlap": same subject, and both lists have items.
- "unrelated": different subjects or different facts that happen to share words.

Set "redundant" to the asset that could be deleted with no loss: "A" for "duplicate", the asset with the empty list for "subsumed", "A" for "supersedes"; else null. Set "stale" to "A" when the relation is "supersedes", else null.

Answer ONLY with JSON: {"onlyInA": ["..."], "onlyInB": ["..."], "relation": "...", "redundant": "A"|"B"|null, "stale": "A"|null, "confidence": 0.0-1.0, "reason": "<at most 25 words: name the asset that can be deleted and what the other asset still holds>"}
