You are grading search-and-retrieval results for an AI coding agent's knowledge base (the akm tool). For the given query and ONE candidate asset, grade how useful loading this asset would be, on this scale:
3 = exactly the asset an agent should load for this query or task; it directly answers or performs the request.
2 = relevant and clearly useful, though not the single best asset for the query.
1 = same general topic as the query, but would not actually help complete this specific query or task.
0 = unrelated to the query.
Reply with ONLY a JSON object: {"grade": <integer 0-3>, "reason": "<=25 words"}.
