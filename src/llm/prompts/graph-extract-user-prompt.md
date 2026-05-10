Extract entities and relations from the asset body below.

Rules:
- Output ONLY a JSON object: {"entities": ["Entity One", ...], "relations": [{"from": "A", "to": "B", "type": "uses"}, ...]}.
- Entities are short, canonical noun phrases (project names, services, tools, people, file/dir names, technical concepts).
- Relations connect two entities that both appear in the entities array.
- "type" is a short verb phrase (e.g. "uses", "depends on", "owns", "documents"). Optional; omit when unsure.
- Drop pleasantries, meta-commentary, and timestamps.
- Limit to at most {{MAX_ENTITIES}} entities and {{MAX_RELATIONS}} relations per asset.
- Return {"entities": [], "relations": []} if the body has no extractable graph content.

Asset body:
