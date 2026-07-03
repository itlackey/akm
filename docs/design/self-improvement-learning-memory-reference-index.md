# AKM Reference Index — Agent Self-Improvement, Self-Learning, Compound Engineering & Memory Management

A curated index of AKM stash assets and external research/articles covering four related domains in agentic AI engineering. Compiled by searching the local `akm` stash (`akm curate` / `akm search --source both`) across ~40 queries and cross-checking with web research for authoritative external sources.

**How to use this doc:** each AKM asset entry lists its `ref` — run `akm show <ref>` to pull the full content into context. External references are grouped by domain and link to the original source.

## Table of Contents

- [1. Agent Self-Improvement](#1-agent-self-improvement)
  - [1.1 AKM Stash Assets](#11-akm-stash-assets)
  - [1.2 External References](#12-external-references)
- [2. Agent Self-Learning](#2-agent-self-learning)
  - [2.1 AKM Stash Assets](#21-akm-stash-assets)
  - [2.2 External References](#22-external-references)
- [3. Compound Engineering](#3-compound-engineering)
  - [3.1 AKM Stash Assets](#31-akm-stash-assets)
  - [3.2 External References](#32-external-references)
- [4. Agent Memory Management](#4-agent-memory-management)
  - [4.1 AKM Stash Assets](#41-akm-stash-assets)
  - [4.2 External References](#42-external-references)
- [5. Cross-Domain Notes](#5-cross-domain-notes)

---

## 1. Agent Self-Improvement

Feedback loops, iterative refinement, self-correction, reflection/self-critique, evaluator-optimizer patterns, RLHF-adjacent agentic tuning.

### 1.1 AKM Stash Assets

**AKM's own self-improvement pipeline**

| Ref | Type | Description |
|---|---|---|
| `knowledge:akm-improve-and-extract` | knowledge | Canonical reference for AKM's own loop: extract (harvest session insights) → improve (propose asset changes) → health (diagnose throughput). |
| `knowledge:akm-self-improving-agents-research-2026` | knowledge | Deep research survey (13 arXiv papers + product docs: Mem0, Zep/Graphiti, LangMem, MemoryOS, MemOS, SAGE, EvolveR, Hindsight, STALE, ProcMEM, Supermemory) mapped to an AKM roadmap. |
| `workflow:spread-improvement-loop` | workflow | Reusable multi-step "spread and improve" iterative refinement loop. |

**Reflection / self-critique / judge patterns**

| Ref | Type | Description |
|---|---|---|
| `wiki:articles/pages/contrastive-reflection` | wiki | "Contrastive Reflection" (arXiv 2606.30840): isolates failure slices vs. nearby successes, only accepts edits that pass validation/regression gates. |
| `wiki:articles/pages/claude-managed-agents` | wiki | Claude's "Managed Agents" stack: dreaming (session review for memory hygiene), rubric-graded outcome retries, multiagent orchestration. |
| `wiki:articles/pages/agent-systems` | wiki | Index/hub page linking dozens of agent-harness, evaluation, and skill-optimization sources. |
| `knowledge:akm-multi-agent-judge-loop-adversarial-verification` | knowledge | Judges must adversarially re-verify prior findings, not rubber-stamp; agents can die mid-task leaving partial edits. |
| `knowledge:dc-design-guide-judge-review-loop-limits` | knowledge | Design-review judge-loop guidance with iteration limits. |
| `knowledge:spread-by-spread-judge-retry-limit` | knowledge | Circuit-breaker pattern capping judge-review retries at 3 attempts to prevent runaway refinement loops. |
| `github:affaan-m/everything-claude-code//skill:agent-self-evaluation` | skill | Post-task self-evaluation: agent rates output against a 5-axis rubric as a reflection step. |
| `github:affaan-m/everything-claude-code//skill:agent-introspection-debugging` | skill | Teaches an agent to debug itself (loop-limit failures, repeated retries with no progress) before escalating. |
| `github:affaan-m/everything-claude-code//agent:agent-evaluator` | agent | Dedicated evaluator agent for grading/critiquing other agents' output. |
| `agent:playwright/test-coverage-judge` | agent | Judge-pattern agent evaluating test coverage as part of an iterative quality loop. |

**Continuous / autonomous agent loops**

| Ref | Type | Description |
|---|---|---|
| `github:affaan-m/everything-claude-code//skill:continuous-agent-loop` | skill | Canonical "loop skill" selecting among continuous-pr, rfc-dag, infinite, or sequential loop strategies. |
| `github:affaan-m/everything-claude-code//agent:loop-operator` | agent | Agent specialized in operating/driving continuous execution loops. |
| `github:affaan-m/everything-claude-code//script:skills/continuous-learning-v2/agents/observer-loop.sh` | script | Observer-loop script implementing a continuous-learning capture cycle. |
| `agent-patterns//knowledge:patterns/continuous-autonomous-task-loop-pattern` | knowledge | agentic-patterns.com pattern describing an autonomous continuous task-loop architecture. |

**Evaluator-optimizer / CI feedback loops** (agentic-patterns.com mirrors)

| Ref | Type | Description |
|---|---|---|
| `agent-patterns//knowledge:patterns/coding-agent-ci-feedback-loop` | knowledge | Agent triggers CI, polls every 30s, patches only failing tests, repeats until green. |
| `agent-patterns//knowledge:patterns/background-agent-ci` | knowledge | Asynchronous variant of the CI feedback loop. |
| `agent-patterns//knowledge:patterns/agent-reinforcement-fine-tuning` | knowledge | "Agent RFT" pattern: fine-tuning agents via reward signals derived from task outcomes (RLHF-adjacent). |
| `agent-patterns//knowledge:patterns/human-in-loop-approval-framework` | knowledge | Human-in-the-loop approval framework for gating agent actions before they're applied. |
| `agent-patterns//knowledge:patterns/dogfooding-with-rapid-iteration-for-agent-improvement` | knowledge | Dogfooding + rapid iteration as a feedback loop for improving agent behavior. |

**Process lessons/memories**

| Ref | Type | Description |
|---|---|---|
| `memory:multi-agent-fix-judge-loop-lessons.derived` | memory | Fix/judge multi-agent loop process lessons (adversarial re-verify, partial-edit risk). |
| `memory:reflect-skipped-reasons-are-critical-for-tuning.derived` | memory | Tracking *why* a reflect pass was skipped is essential for tuning self-improvement pipelines. |
| `knowledge:multi-agent-process-lessons` | knowledge | Cross-cutting lessons from running multi-agent processes. |

### 1.2 External References

- [Building Effective AI Agents](https://www.anthropic.com/research/building-effective-agents) — Anthropic's canonical post defining composable agent workflow patterns, incl. the Evaluator-Optimizer pattern.
- [Self-Refine: Iterative Refinement with Self-Feedback](https://learnprompting.org/docs/advanced/self_criticism/self_refine) — generate → self-feedback → refine loop that improves outputs without external supervision.
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366) — agents verbally reflect on feedback and store reflective text in episodic memory to improve future trials without weight updates.
- [CRITIC: LLMs Can Self-Correct with Tool-Interactive Critiquing](https://arxiv.org/abs/2305.11738) — LLM uses external tools to validate and iteratively revise its own outputs.
- [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) — ICLR 2024 counterpoint paper: intrinsic self-correction without external feedback often fails or degrades reasoning.
- [Self-Improving Coding Agents](https://addyosmani.com/blog/self-improving-agents/) — practitioner write-up on coding agents that reflectively capture lessons during a session.
- [Closing the Loop: Coding Agents, Telemetry, and the Path to Self-Improving Software](https://arize.com/blog/closing-the-loop-coding-agents-telemetry-and-the-path-to-self-improving-software/) — using observability/telemetry as the feedback signal.
- [Agentic Loops: From ReAct to Loop Engineering (2026 Guide)](https://datasciencedojo.com/blog/agentic-loops-explained-from-react-to-loop-engineering-2026-guide/) — overview of "loop engineering" for agent act-observe-decide-repeat cycles.
- [Learning to Summarize with Human Feedback](https://openai.com/index/learning-to-summarize-with-human-feedback/) — OpenAI's foundational RLHF post.
- [Learning from Human Preferences](https://openai.com/index/learning-from-human-preferences/) — OpenAI/DeepMind precursor to RLHF for agents.

---

## 2. Agent Self-Learning

Continuous learning, lesson capture, learning from outcomes/feedback, procedural memory formation, skill acquisition over time.

### 2.1 AKM Stash Assets

**Skills**

| Ref | Type | Description |
|---|---|---|
| `github:affaan-m/everything-claude-code//skill:continuous-learning-v2` | skill | Instinct-based learning: observes sessions via hooks, extracts atomic "instincts" with confidence scoring, evolves them into skills/commands/agents; v2.1 adds project scoping. |
| `github:affaan-m/everything-claude-code//skill:agent-self-evaluation` | skill | Post-task self-rating (5-axis rubric) — lightweight reflection-style learning primitive. |
| `github:affaan-m/everything-claude-code//skill:skill-stocktake` | skill | Quality-audit skill for auditing skills/commands (Quick Scan or Full Stocktake). |
| `itlackey/akm-stash//skill:akm-dream` | skill | Wraps AKM's `improve`+`extract` pipeline with an explicit plan-review gate, lock, backups, and audit trail for reviewed memory consolidation. |
| `github:getsentry/skills//skill:skill-writer` | skill | Guidance for authoring new Claude skills — the skill-compilation side of self-learning. |

**Agents & scripts**

| Ref | Type | Description |
|---|---|---|
| `github:affaan-m/everything-claude-code//agent:skills/continuous-learning-v2/agents/observer` | agent | Background agent that analyzes session logs to detect behavioral patterns and mint new "instincts". |
| `github:affaan-m/everything-claude-code//agent:loop-operator` | agent | Operates autonomous agent loops; monitors and intervenes when a loop stalls. |
| `github:affaan-m/everything-claude-code//script:skills/continuous-learning-v2/agents/start-observer.sh` | script | Launches the background observer agent. |
| `github:affaan-m/everything-claude-code//script:skills/continuous-learning-v2/agents/observer-loop.sh` | script | Continuously-running loop driver for instinct extraction. |
| `github:affaan-m/everything-claude-code//script:skills/continuous-learning-v2/agents/session-guardian.sh` | script | Session-lifecycle guardrail for the observer/instinct pipeline. |
| `workflow:spread-improvement-loop` | workflow | Learning-loop-orchestration workflow that "spreads" learned improvements. |

**Knowledge**

| Ref | Type | Description |
|---|---|---|
| `knowledge:akm-self-improving-agents-research-2026` | knowledge | Research landscape doc comparing self-improving agent memory systems, cited for AKM's own roadmap. |
| `knowledge:agent-memory-taxonomy` | knowledge | Four-type memory taxonomy (semantic, entity, episodic, procedural) for context-window/durability management. |
| `knowledge:agentic-memory-systems-state-of-the-art-2026` | knowledge | Reference on memory architectures (MemGPT, Mem0, Zep, MemTier) and consolidation/dedup best practices. |
| `agent-patterns//knowledge:patterns/agent-reinforcement-fine-tuning` | knowledge | "Agent RFT" pattern — RL-based agent tuning from outcomes. |
| `agent-patterns//knowledge:patterns/action-caching-replay` | knowledge | "Action Caching & Replay" pattern — caching/replaying prior agent action trajectories (experience-replay adjacent). |
| `agent-patterns//knowledge:patterns/autonomous-workflow-agent-architecture` | knowledge | Autonomous workflow agent architecture for sustained learning-loop orchestration. |
| `knowledge:distillation-filtering-and-reflect-gating-separation` | knowledge | AKM's architectural separation between "distill" (lesson extraction) and "reflect" (gating) loops. |
| `knowledge:wave-based-self-improvement-workflow` | knowledge | AKM pattern for staging large self-improvement plans into waves with parallel quality gates. |
| `github:coreyhaines31/marketingskills//knowledge:skills/marketing-loops/references/loop-orchestration` | knowledge | Generic "loop orchestration" reference: independent operational loops compose with data flowing down and learnings flowing back up. |
| `wiki:articles/raw/nirdiamant-agent-memory-techniques` | wiki | Snapshot of NirDiamant/Agent_Memory_Techniques — 30 runnable notebooks on memory techniques incl. MemGPT, Mem0, Letta, Zep, Graphiti. |
| `knowledge:multi-agent-process-lessons` | knowledge | Learning-from-failure case study on agent session-limit deaths leaving partial state. |

**Lessons & memories (concrete internal case studies)**

| Ref | Type | Description |
|---|---|---|
| `lesson:wiki-articles-raw-blog-continual-learning-for-ai-agents-1-lesson` | lesson | Continual learning happens at 3 layers (model weights, harness logic, context/retrieval); harness/context is the cost-efficient lever. |
| `lesson:memory-akm-improve-salience-working-reference-lesson` | lesson | AKM's high-salience admission gate requiring `asset_salience` rows for new distilled assets to surface. |
| `memory:outcome-loop-warm-start-cap.derived` | memory | AKM's `WARM_START_CAP=0.3` constant limiting utility EMA seeding to prevent rare assets being outcompeted. |
| `memory:improve-p0a-fallback-for-zero-feedback-assets.derived` | memory | Routes zero-feedback assets to a `noFeedbackPool` instead of skipping — cold-start fix for the outcome-feedback loop. |
| `memory:improve-self-learning-wiring-branch.derived` | memory | Status/wiring notes for AKM's own "improve self-learning" branch that closed the outcome loop by default. |

### 2.2 External References

- [Continual learning for AI agents](https://www.langchain.com/blog/continual-learning-for-ai-agents) — LangChain post framing continual learning as accumulating high-signal memory across token/weight/latent-space surfaces.
- [Self-Improving Loop: How to Build AI Agents That Actually Learn](https://www.analyticsvidhya.com/blog/2026/06/self-improving-loops/) — building a self-healing agent loop that scores its own output and updates behavior.
- [How to Build a Self-Improving AI Agent That Learns From Its Own Mistakes](https://www.mindstudio.ai/blog/self-improving-ai-agent-feedback-loop) — guide on feedback loops where agents write down and reapply lessons.
- [Loop Engineering for AI Agents: Memory-First Design](https://mem0.ai/blog/loop-engineering-for-ai-agents-memory-first-design) — Mem0's post on designing agent loops around memory as the central element.
- [Built-in memory for Claude Managed Agents ("Dreaming")](https://claude.com/blog/claude-managed-agents-memory) — Anthropic's async background process reviewing past session transcripts to extract patterns and consolidate memory.
- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents) — Anthropic engineering post on the managed-agent architecture underlying the memory/dreaming loop.
- [Memory tool — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) — official docs for Claude's memory tool enabling persistence/retrieval across sessions.
- [Rethinking Memory Mechanisms of Foundation Agents in the Second Half: A Survey](https://arxiv.org/pdf/2602.06052) — 2026 arXiv survey on memory mechanisms in foundation-model agents.
- [From Raw Experience to Skill Consumption: A Systematic Study of Model-Generated Agent Skills](https://arxiv.org/pdf/2605.23899) — how agents convert raw experience into reusable, consumable skills (procedural memory formation).
- [Trajectory-Informed Memory Generation for Self-Improving Agent Systems](https://arxiv.org/html/2603.10600v1) — generating memory from agent trajectories to drive self-improvement.

---

## 3. Compound Engineering

The practice of engineering work where each unit of work makes future work faster/easier — codifying lessons into reusable skills/agents/workflows.

### 3.1 AKM Stash Assets

**Core pattern**

| Ref | Type | Description |
|---|---|---|
| `agent-patterns//knowledge:patterns/compounding-engineering-pattern` | knowledge | Canonical definition (mirrored from agentic-patterns.com): codify learnings from each feature into reusable prompts/slash-commands/subagents/hooks; Build→Document→Codify→Reuse→Easier loop, with Dan Shipper/Every quotes. |
| `knowledge:compound-engineering-latency-budget` | knowledge | AKM's own note: sub-30-min session-to-stash latency is a requirement for compound engineering feedback loops. |
| `knowledge:wave-based-self-improvement-workflow` | knowledge | Staged-wave implementation pattern for compounding large self-improvement changes safely. |
| `knowledge:akm-constitutional-rules-for-codebase-maintenance` | knowledge | "Constitution-first, then grep-your-own-edits" — write a rule, then audit your own next edits for violations. |

**Related agentic-patterns.com mirrors**

| Ref | Type | Description |
|---|---|---|
| `agent-patterns//knowledge:patterns/agent-powered-codebase-qa-onboarding` | knowledge | Agent-assisted codebase Q&A/onboarding using semantic search + code graphs. |
| `agent-patterns//knowledge:patterns/codebase-optimization-for-agents` | knowledge | Structuring a codebase (docs, conventions, tooling) so agents are more effective. |
| `agent-patterns//knowledge:patterns/coding-agent-ci-feedback-loop` | knowledge | CI/test feedback loops so coding agents self-correct — named as synergistic with compounding engineering. |
| `agent-patterns//knowledge:patterns/black-box-skill-invocation` | knowledge | Invoking reusable "skills" as encapsulated black boxes. |
| `agent-patterns//knowledge:patterns/cli-first-skill-design` | knowledge | CLI-first design for agent skills so they're composable/reusable — supports a durable skill library. |

**Skills (durable leverage / reusable skill library)**

| Ref | Type | Description |
|---|---|---|
| `skill:coding` | skill | AKM's top-level "Coding" skill bundling security review, CLI-workflow-creator, code-quality sub-skills. |
| `skill:coding/git-release` | skill | Repeatable SemVer + changelog release workflow codified as a skill — textbook compounding-engineering artifact. |
| `github:affaan-m/everything-claude-code//skill:ai-first-engineering` | skill | AI-first engineering practices/workflow design for coding agents. |
| `github:affaan-m/everything-claude-code//skill:agentic-engineering` | skill | Agentic engineering practices generally (system prompts, subagents, hooks). |
| `github:affaan-m/everything-claude-code//skill:agentic-os` | skill | "Agentic operating system" approach to organizing agent workflows/skills/hooks. |
| `github:affaan-m/everything-claude-code//skill:skill-stocktake` | skill | Auditing/reconciling an existing skill library — maintaining a compounding skill inventory. |
| `github:affaan-m/everything-claude-code//skill:codebase-onboarding` | skill | AI-driven onboarding to unfamiliar codebases (leverage/reuse angle). |

**Registry kit (Every's official plugin — not yet installed locally)**

| Ref | Type | Description |
|---|---|---|
| `ce:*` (`ce-brainstorm`, `ce-plan`, `ce-work`, `ce-compound`, `ce-code-review`, `ce-ideate`, `ce-debug`, `ce-commit`, `ce-worktree`, `ce-simplify-code`, etc.) | command/skill kit | Every's official Compound Engineering plugin, surfaced via `akm search --source registry` (matches `EveryInc/compound-engineering-plugin`). Implements brainstorm→plan→work→review→compound as installable slash commands. |

### 3.2 External References

- [Compound Engineering — Every](https://every.to/guides/compound-engineering) — Every's flagship guide defining the philosophy.
- [Compound Engineering: How Every Codes With Agents](https://every.to/chain-of-thought/compound-engineering-how-every-codes-with-agents) — how Every built Cora using brainstorm → work → review → compound.
- [Compound Engineering Gets an Upgrade — Every](https://every.to/p/compound-engineering-gets-an-upgrade) — refinements to Every's workflow/plugin.
- [Every's compounding-engineering topic hub](https://every.to/c/compounding-engineering) — collected essays and podcast episodes.
- [How Two Engineers Ship Like a Team of 15 With AI Agents — Every](https://every.to/podcast/how-two-engineers-ship-like-a-team-of-15-with-ai-agents) — case study shipping 6 features/5 bug fixes/3 infra updates in one week.
- [Claude Code Camp: The Workflows Turning One Engineer Into Ten — Every](https://every.to/source-code/claude-code-camp) — concrete Claude Code workflows underlying the practice.
- [GitHub: EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) — official open-source plugin for Claude Code, Codex, Cursor, etc.
- [Compounding Engineering Pattern — agentic-patterns.com](https://www.agentic-patterns.com/patterns/compounding-engineering-pattern) — pattern-library entry with problem/solution/trade-offs.
- [Learning from Every's Compound Engineering — Irrational Exuberance (Will Larson)](https://lethain.com/everyinc-compound-engineering/) — independent engineering-leadership analysis/critique.
- [Compound Engineering + AGENTS.md for Claude Code — WotAI](https://wotai.co/blog/compound-engineering-agents-md) — connects the practice to the AGENTS.md/CLAUDE.md convention.
- [Kieran Klaassen on X: "What is Compound Engineering?"](https://x.com/kieranklaassen/status/2020638198649811203) — short explainer thread by the term's originator (Every/Cora).

Note: the term was coined by **Kieran Klaassen** (Every, building Cora) and popularized by **Dan Shipper** (Every co-founder). Anthropic's official "superpowers" plugin reportedly overlaps in coverage (brainstorm/plan/review/simplify skills).

---

## 4. Agent Memory Management

Short-term/working memory, long-term memory stores, retrieval architectures, consolidation/forgetting, context-window management, salience/ranking, multi-agent shared memory.

### 4.1 AKM Stash Assets

**Design references**

| Ref | Type | Description |
|---|---|---|
| `wiki:articles/raw/nirdiamant-agent-memory-techniques` | wiki | Snapshot of NirDiamant/Agent_Memory_Techniques — 30 notebooks on buffers, vector stores, KGs, episodic/semantic memory, MemGPT, Mem0, Letta, Zep, Graphiti, LoCoMo benchmarks. |
| `wiki:articles/raw/html-2605-18747v1` | wiki | arXiv paper "Code as Agent Harness" — §3.2 taxonomy of Working/Semantic/Experiential/Long-Term/Multi-Agent memory + context compaction/state offloading. |
| `knowledge:agent-memory-taxonomy` | knowledge | Four-part memory taxonomy (semantic, entity, episodic, procedural) + durability-vs-transience heuristic + pinned-state/working-context/cold-storage pattern. |
| `knowledge:agentic-memory-systems-state-of-the-art-2026` | knowledge | Comparison of MemGPT, Mem0, Zep, MemTier, TiMem, SEDM with async consolidation, dual-buffer promotion, dedup thresholds (cosine 0.85–0.9), adaptive admission control. |

**Consolidation, salience, forgetting**

| Ref | Type | Description |
|---|---|---|
| `knowledge:memory-consolidation-metrics` | knowledge | Tracking `judgedNoAction` as a metric to quantify previously-invisible memory-processing inefficiency. |
| `knowledge:akm-extract-retrieval-salience` | knowledge | Empirical finding: only ~5% of memory/knowledge assets in a large corpus are ever retrieved — the long-tail/dead-memory problem. |
| `knowledge:ws-1-salience-vector-structure` / `knowledge:ws-1-salience-vector-pipeline` | knowledge | Design docs for a salience-vector structure/pipeline used to rank and promote memories. |
| `knowledge:memory-inference-idempotent-design` | knowledge | Making memory-inference/consolidation passes idempotent via an LLM-response cache. |
| `knowledge:akm-memory-yield-root-cause` | knowledge | Root-cause analysis of low "yield" — how much raw session data converts into durable memory assets. |
| `itlackey/akm-stash//skill:akm-dream` | skill | "Dream" skill: plan-review gate, lock, backups, audit trail for merge/delete/promote/contradict memory operations — staged consolidation + forgetting with human-in-the-loop review. |

**Retrieval & context-window management**

| Ref | Type | Description |
|---|---|---|
| `agent:knowledge/projects/rlm/reference/context-manager` | agent | Stateless "RLM Context Manager" — one state operation (init/prepare/get_context/finalize) per spawn, discarding context after — externalized working-memory pattern. |
| `github:affaan-m/everything-claude-code//skill:context-budget` | skill | Audits token overhead across agents/skills/MCP servers/rules; produces prioritized token-savings recommendations. |
| `github:affaan-m/everything-claude-code//skill:iterative-retrieval` | skill | Four-phase (dispatch/evaluate/refine/loop) iterative retrieval pattern for progressively narrowing context — RAG-for-memory pattern. |
| `github:affaan-m/everything-claude-code//skill:agentic-os` | skill | Persistent, file-based multi-agent memory architecture: kernel routing, per-agent "Memory Scope," append-only daily logs, auto-reflection. |
| `agent:skills/lead-intelligence/agents/enrichment-agent` | agent | Applied RAG-for-memory pattern — retrieval-augmented long-term memory lookups for lead data. |

**Adjacent tooling landscape**

| Ref | Type | Description |
|---|---|---|
| `knowledge:cairn-ai-agent-memory-landscape` | knowledge | Catalogues distinct AI-agent-memory tools named "Cairn" (state-space search engine, semantic-memory MCP server on Postgres+pgvector, persistent reasoning graph). |
| `knowledge:crewai-nasc-integration-guide` | knowledge | Session/state persistence patterns for CrewAI-based agents. |

### 4.2 External References

- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) — foundational paper (Packer et al., 2023): OS-inspired virtual context management with a two-tier main/external memory architecture and self-editing memory via tool use.
- [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) — Park et al. (2023): memory stream + reflection + planning architecture with importance-scored reflection synthesis.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — Anthropic engineering post (Sept 2025) on curating the optimal token budget across an agent's inference.
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413) — Chhikara et al. (2025): extract/update architecture (ADD/UPDATE/DELETE/NOOP) plus a graph-based variant.
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956) — Rasmussen et al. (2025): bi-temporal knowledge-graph memory layer (Graphiti), outperforms MemGPT on Deep Memory Retrieval.
- [Short-term memory — LangChain Docs](https://docs.langchain.com/oss/python/langchain/short-term-memory) — thread-level short-term memory via checkpointers vs. cross-thread long-term memory via persistent stores.
- [Graphiti: Temporal Knowledge Graphs for Agentic Apps](https://blog.getzep.com/graphiti-knowledge-graphs-for-agents/) — Zep engineering blog on Graphiti's real-time, incrementally-updated knowledge-graph engine.

---

## 5. Cross-Domain Notes

- **Overlap:** several assets belong to more than one domain — most notably `knowledge:akm-self-improving-agents-research-2026`, `itlackey/akm-stash//skill:akm-dream`, and the `agentic-patterns.com` mirrors under `agent-patterns//knowledge:patterns/*`. They're listed once under their primary domain above; check adjacent sections if searching by keyword.
- **AKM's own dogfood loop** (`extract` → `improve` → `reflect`/`distill` → `health`) is a running real-world instance of all four domains at once: self-improvement (judge/gate loops), self-learning (outcome-feedback tuning, salience), memory management (consolidation, salience vectors, forgetting via `akm-dream`), and compound engineering (wave-based staged rollout, constitution-first rules).
- **Term provenance:** "compound engineering" (§3) traces to a specific named source (Kieran Klaassen / Every); the other three domains are broader industry terms without a single coiner — their external references instead anchor on foundational papers (MemGPT, Generative Agents, Reflexion) and primary engineering blogs (Anthropic, OpenAI, LangChain, Mem0, Zep).
- **Registry vs. stash:** the Compound Engineering section (§3.1) is the only one pointing at an uninstalled registry kit (Every's `ce:*` plugin) rather than local stash content — run `akm search "compound engineering" --source registry` and install if you want the full command set materialized locally.
