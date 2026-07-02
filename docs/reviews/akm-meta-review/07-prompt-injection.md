# 07 — Prompt injection: akm re-injects stored content into future sessions

> Adapts **"Prompt injection handling"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> akm is a uniquely juicy injection target: it ingests untrusted content (web pages via wiki, session transcripts via extract, third-party registry kits) and later injects that content back into agent context (SessionStart payload, curate/search results, recalled memories). A poisoned asset is a persistent, cross-session foothold.

## Prompt

```text
Threat-model akm as a prompt-injection surface. It both ingests untrusted content
and re-injects stored content into future agent sessions — trace the full path.

1. Map every INPUT avenue and mark its trust level:
   - wiki stash of arbitrary web pages (untrusted HTML/markdown).
   - extract over session transcripts (semi-trusted; contain tool output, pasted
     web content, other models' text).
   - registry kits / stash-makers from third-party GitHub repos (untrusted).
   - improve pipeline consuming its own prior output (feedback loop risk).
   - config.json, env/secret assets (owner-controlled; integrity not injection).
   For each: which model processes it, at what privilege, and with what tools
   available at that moment.

2. Map every OUTPUT/RE-INJECTION avenue — where stored content re-enters a live
   agent context: the SessionStart hook payload, curate/search result bodies,
   memory recall blocks, the improve judge reading candidate text, workflow/agent/
   command asset bodies dispatched via the akm skills. This is the payload delivery
   path; enumerate it precisely.

3. Identify the highest-severity chains — untrusted input that reaches a
   high-privilege re-injection point. Concretely test: can a crafted web page
   stashed as a wiki, or a poisoned string in a session transcript, produce a
   memory/lesson that the SessionStart hook later injects as instructions into every
   future session? Can a registry kit ship an agent/command asset whose body is
   attacker-controlled? Write the actual attack narrative for the worst chain.

4. Given the data and tools akm actually has, define the defense: input isolation
   (content vs. instructions boundary), provenance/trust tagging that survives into
   recall, sanitization at stash time, and privilege reduction at re-injection time.
   Research current best practices (spotlighting/delimiting, data-marking,
   least-privilege tool exposure) and recommend what fits akm's architecture.
   Prefer removing a dangerous re-injection path over wrapping it in a sanitizer.

5. Output: findings/07-prompt-injection.md — the input/output surface map, the
   ranked attack chains with narratives, and a phased hardening plan.

Guardrails: read-only on live data; do NOT stash new content or trigger runs to
test attacks against the live stash — reason about the paths and, if you must
demonstrate, use an isolated sandbox HOME/XDG (see the isolate-config memory).

ultracode
```

## Refs

Stash:

- `agent:security-reviewer` (from `github:affaan-m/everything-claude-code`) — a ready security-reviewer persona to dispatch on the code paths.
- `command:skills/coding/application-security-review/commands/security-code-review-pass` — a structured security-review pass template.
- `skill:code-review-security` (from `github:hieutrtr/ai1-skills`) — security review methodology.
- `memory:isolate-config-in-init-repros` (see MEMORY.md) — how to sandbox HOME/XDG so any demonstration never touches live data.

Repo:

- `docs/technical/architecture.md` — the input/output boundaries to trace.
- `docs/wikis.md` — the untrusted-web-content ingestion path.
- `docs/registry.md`, `docs/stash-makers.md` — the third-party kit ingestion path.
- `docs/data-and-telemetry.md` — what gets stored from transcripts and how.
- The Claude Code + opencode hook/plugin code — the SessionStart re-injection payload path (grep for the SessionStart hook that emits the "AKM is available" context).
