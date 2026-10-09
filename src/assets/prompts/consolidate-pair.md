You compare two assets from one person's agent-memory library (memories and knowledge notes an AI coding agent reads). Asset A is the OLDER one and asset B the NEWER one, by the dates shown, unless both carry the same date and are labelled "same age". akm deletes one of them only when the other keeps every claim a reader would need, so your two lists decide what is safe to delete.

First list what each asset has that the other lacks:
- "onlyInA": every durable claim of A that B does not state or replace.
- "onlyInB": every durable claim of B that A does not state or replace.

A durable claim is a fact, decision, value, command, flag, path, file name, URL, number, version, name, error message, condition or rule someone would act on. Ignore wording, headings, dates of writing, tags and boilerplate. A claim is stated when the other asset says it in any wording or format. It is not stated when the other asset is vaguer (a config file instead of the specific path) or drops a number, command, step or condition. Write each item as a short phrase that quotes its identifier. Use [] when there is nothing.

B replaces a claim of A only when it gives a new value for it and shows that the new value is current: B says so (now, instead of, since, renamed, corrected, no longer) or B is created later than A. A different value with neither sign is a conflict, not a replacement: list A's value in "onlyInA" and B's value in "onlyInB".

Then classify the relation as exactly one of:
- "duplicate": both lists are empty.
- "subsumed": exactly one list is empty. The asset with the empty list is redundant.
- "supersedes": B replaces a claim in A as defined above (a newer version, a changed decision, a fixed bug, a new value), and onlyInA is empty.
- "contradicts": they make logically exclusive claims about the same thing and nothing shows which one is current: B does not say it replaces the claim and was not created later.
- "overlap": same subject, and both lists have items.
- "unrelated": different subjects or different facts that happen to share words.

Set "redundant" to the asset that could be deleted with no loss: "A" for "duplicate", the asset with the empty list for "subsumed", "A" for "supersedes"; else null. Set "stale" to "A" when the relation is "supersedes", else null.

Answer ONLY with JSON: {"onlyInA": ["..."], "onlyInB": ["..."], "relation": "...", "redundant": "A"|"B"|null, "stale": "A"|null, "confidence": 0.0-1.0, "reason": "<at most 25 words: name the asset that can be deleted and what the other asset still holds; for supersedes, quote the words of B that replace the claim or say B is created later>"}
