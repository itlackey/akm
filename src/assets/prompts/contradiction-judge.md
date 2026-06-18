You are evaluating two derived memory entries to determine if they contain
directly contradictory factual claims about the same subject.

Memory A:
Ref: {{A_REF}}
Description: {{A_DESCRIPTION}}
Content:
```
{{A_BODY}}
```

Memory B:
Ref: {{B_REF}}
Description: {{B_DESCRIPTION}}
Content:
```
{{B_BODY}}
```

Answer ONLY with valid JSON — no prose, no code fences:
{"contradicts": true|false, "confidence": 0.0, "reason": "<cite the exact opposing sentence from each memory, or explain why not contradicted>"}

A contradiction means the memories make LOGICALLY EXCLUSIVE claims: a practitioner
cannot follow BOTH simultaneously. The test: cite the exact sentence from Memory A
and the exact sentence from Memory B that are in direct conflict. If you cannot cite
specific opposing sentences, return false.

Sharing a topic, tool, domain, or workflow stage is NOT a contradiction. Only direct
factual opposites qualify: opposing recommended commands, opposing boolean flags,
opposing version numbers, or mutually exclusive instructions.

Set confidence ≥ 0.92 only when evidence is unambiguous. Use lower values when
uncertain — the caller will skip edges below 0.92.