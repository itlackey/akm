Extract entities and relations from the asset body below.

Rules:
- Output ONLY a JSON object: {"entities": ["Entity One", ...], "relations": [{"from": "A", "to": "B", "type": "uses"}, ...]}.
- Entities are short, canonical noun phrases (project names, services, tools, people, technical concepts). Do NOT emit file or directory paths (anything containing "/" or "\") — they are dropped downstream.
- Relations connect two entities that both appear in the entities array.
- "type" is a short verb phrase (e.g. "uses", "depends on", "owns", "documents"). Optional; omit when unsure.
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
{"entities":["auth-service","PostgreSQL","redis-cache","terraform-provisioner","prod cluster","@alice"],"relations":[{"from":"auth-service","to":"PostgreSQL","type":"uses"},{"from":"auth-service","to":"redis-cache","type":"depends on"},{"from":"terraform-provisioner","to":"prod cluster","type":"deploys"},{"from":"terraform-provisioner","to":"auth-service","type":"deploys"},{"from":"@alice","to":"auth-service","type":"owns"}]}

Input:
## Meeting: API Redesign
Discussed moving from REST to GraphQL. The frontend team will use Apollo Client.
Backend needs to implement resolvers. Timeline: Q2.

Output:
{"entities":["REST","GraphQL","Apollo Client","frontend team","backend","resolvers","Q2"],"relations":[{"from":"frontend team","to":"Apollo Client","type":"uses"},{"from":"backend","to":"resolvers","type":"implements"},{"from":"frontend team","to":"GraphQL","type":"migrates to"}]}

===============

Request:

