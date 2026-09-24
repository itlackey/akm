Extract entities and relations from the asset body below.

Rules:
- Output ONLY a JSON object: {"entities": ["Entity One", ...], "relations": [["A", "uses", "B"], ...]}.
- Entities are short, canonical noun phrases (project names, services, tools, people, technical concepts). Do NOT emit file or directory paths (anything containing "/" or "\") — they are dropped downstream.
- Each relation is a 3-element array: [from, type, to]. Relations connect two entities that both appear in the entities array.
- "type" is a short verb phrase (e.g. "uses", "depends on", "owns", "documents"). Use "" when unsure.
- Drop pleasantries, meta-commentary, and timestamps.
- Limit to at most {{MAX_ENTITIES}} entities and {{MAX_RELATIONS}} relations per asset.
- Return {"entities": [], "relations": []} if the body has no extractable graph content.
- DO NOT return markdown code blocks, ONLY valid JSON objects.

Examples:

Input:
## Deployment Notes
The auth-service uses PostgreSQL for user sessions. It depends on the redis-cache
for rate limiting. The terraform-provisioner deploys everything to the prod cluster.
Owner: @alice.

Output:
{"entities":["auth-service","PostgreSQL","redis-cache","terraform-provisioner","prod cluster","@alice"],"relations":[["auth-service","uses","PostgreSQL"],["auth-service","depends on","redis-cache"],["terraform-provisioner","deploys","prod cluster"],["terraform-provisioner","deploys","auth-service"],["@alice","owns","auth-service"]]}

Input:
## Meeting: API Redesign
Discussed moving from REST to GraphQL. The frontend team will use Apollo Client.
Backend needs to implement resolvers. Timeline: Q2.

Output:
{"entities":["REST","GraphQL","Apollo Client","frontend team","backend","resolvers","Q2"],"relations":[["frontend team","uses","Apollo Client"],["backend","implements","resolvers"],["frontend team","migrates to","GraphQL"]]}

===============

Request:

