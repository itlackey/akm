# akm Self-Improvement System — Competitive Analysis and Recommendations

> Analysis date: 2026-05-11
> Sources: mem0 (arXiv 2504.19413), Zep (arXiv 2501.13956), MemGPT (arXiv 2310.08560), Reflexion (arXiv 2303.11366), ExpeL (arXiv 2308.10144), MemRL (arXiv 2601.03192), CoALA (arXiv 2603.04740), MemOS (arXiv 2507.03724), A-MEM (arXiv 2502.12110)

---

## Executive Summary

akm is a curated procedural knowledge base manager — it stores skills, commands, workflows, lessons, and memory observations as versioned markdown files with typed frontmatter, not a conversational memory system for personal facts. Within that use case, akm has five genuine competitive advantages not found in any peer system, most significantly its human-gated proposal queue — the only production mechanism in the field for catching automated self-reinforcing errors before they propagate. The highest-leverage improvement opportunities are all within the existing architecture at Days-to-Weeks scale: closing the utility score feedback loop, unblocking high-utility zero-feedback assets from the improve pipeline, requiring a `--reason` on negative feedback to give the distill LLM a verbal gradient, and replacing hard deletes with soft-invalidation archives in the consolidation path. Months-scale architectural proposals from conversational memory systems (MemGPT in-loop self-editing, full bi-temporal graph modeling, Ebbinghaus decay for skills) are scope-mismatched and explicitly rejected.

---

## Scope Note

akm is a curated knowledge base manager, not a conversation memory system. mem0, Zep, and MemGPT solve the problem of persisting personal facts extracted from ongoing conversations (names, preferences, relationship history). akm solves the problem of maintaining a quality-controlled library of reusable procedural knowledge (skills, commands, workflows) and captured insights (lessons, memories, knowledge documents) for agents and teams.

This distinction is load-bearing for every recommendation below:

- Automatic extraction from conversation turns is appropriate for the `memory:` tier only. It is quality-degrading for `skill:`, `command:`, `workflow:`, and `knowledge:` tiers, which require deliberate authorship.
- Temporal decay models (Ebbinghaus forgetting curves) are calibrated on personal episodic facts. A correctly authored `skill:deploy` does not become less relevant because it was not recently accessed — it becomes outdated when the underlying toolchain changes. These are different failure modes requiring different responses.
- The "flat hierarchy" critique from gap analyses that compare akm to CoALA's cognitive science model is a category error. CoALA's four-tier stack (working → episodic → semantic → procedural) describes agent self-state. akm's ten typed asset types (`skill`, `command`, `agent`, `knowledge`, `script`, `memory`, `workflow`, `vault`, `wiki`, `task`) are tool and knowledge artifact categories — a different taxonomy for a different purpose.

All recommendations in this document are scoped to akm's actual use case and labeled with the asset tier(s) they apply to.

---

## Competitive Landscape Summary

| System | Ingestion approach | Conflict handling | Temporal model | Hierarchy | Self-improvement loop |
|---|---|---|---|---|---|
| **mem0** | Fully automatic from every conversation turn (LLM extraction, M=10 messages) | LLM-driven ADD/UPDATE/DELETE/NOOP per candidate; soft-delete in graph variant | None for vector store; edge `invalid` flag in graph variant (Mem0g) | None (flat key-value facts) | None (evaluation-only, no self-correction) |
| **Zep** | Fully automatic from conversation (NER + entity resolution + BM25) | LLM-based edge resolver; bi-temporal edges: old edge `t_invalid` set when contradicted | Full bi-temporal (4 timestamps per edge: valid_from, valid_until, created, expired) | Entity-relationship graph (Graphiti engine) | None; retrieval quality via RRF reranking |
| **MemGPT/Letta** | Agent self-initiates via tool calls mid-reasoning; requires persistent stateful server | Agent-driven summarization / selective replacement when context fills | None (no timestamps on memories) | Two-tier: in-context core memory ("RAM") + external archival ("disk") | In-loop: agent calls `core_memory_replace`, `archival_memory_insert` during reasoning |
| **Reflexion** | Manual + verbal self-critique on failure stored as episodic buffer entry | None; writes verbal critiques alongside originals | None | None (flat episodic buffer) | Verbal reinforcement: binary failure → verbal critique → inject as context on retry |
| **MemRL** | Manual seed + reward-signal utility updates | None; utility decay de-prioritizes distractor memories | Utility score decay: `utility += lr × (reward − utility)` | None (flat episodic with utility floats) | Two-phase retrieval: semantic filter → utility re-rank; scores updated after each retrieval |
| **ExpeL** | Automatic collection of success + failure trajectories | Contrast-based: rule must explain success/failure differential, not just success | None | None (heuristics store) | Extract discriminative rules from trajectory pairs; store as reusable heuristics |
| **akm** | Fully manual (`akm remember`) for `memory:`; deliberate authorship for all other tiers | Chunked LLM consolidation plan (when `memory_consolidation` flag enabled); hard deletes | None (only `createdAt` tracked; no expiry, no decay, no soft-invalidation) | Ten typed asset types; FTS5 + vector unified index | Signal filter → distill → proposal queue → human review → commit |

---

## What akm Does Better

### 1. Human-gated proposal queue — the only production mechanism for catching automated errors

Every peer system promotes automated memory writes directly to the live store: mem0 auto-writes after four-operation LLM resolution; Zep auto-invalidates edges; MemGPT agents self-modify without review. mem0 explicitly acknowledges this as an open gap: "high-relevance memories become confidently wrong rather than outdated; the system lacks mechanisms to flag this." akm's proposal queue stages every automated output (reflect, distill, consolidate promote) for human review before it affects live behavior. This is the only production-deployed mechanism in the reviewed literature for interrupting self-reinforcing error loops before they propagate to the active stash.

### 2. Typed asset system with frontmatter validation — no peer has this

akm's ten typed asset types with type-specific renderers, YAML frontmatter linting (`lintLessonContent` in `src/commands/distill.ts`, `validateKnowledgeContent` in the same file), and directory conventions enforce structural correctness before assets enter the proposal queue. mem0 stores flat key-value facts. Zep stores entity-relationship triples. MemGPT stores free-text blobs. The distinction between `skill:deploy` and `knowledge:deploy-reference` is meaningful, queryable, and enforced — no competitor supports this.

### 3. Multi-source stash with sync — unique in this space

akm's `SourceProvider` interface ingests assets from git repositories, npm packages, websites, and local filesystems into a unified FTS5 + vector index. This enables team-shared skill libraries, versioned kit repositories, and documentation ingestion. No conversational memory system (mem0, Zep, MemGPT) supports multi-source sync because their unit of storage is personal facts, not shareable knowledge artifacts.

### 4. Open markdown standard — not proprietary database lock-in

Every akm asset is a human-readable, git-diffable markdown file with YAML frontmatter. mem0 requires a vector database (Qdrant/Pinecone/Chroma). Zep requires the Graphiti graph database. MemGPT/Letta requires the Letta server. akm assets survive any tool migration; they can be edited with any text editor, reviewed in any code review system, and versioned in any git repository.

### 5. Utility score infrastructure already in place (MemRL foundation)

The SQLite utility score table (`getUtilityScoresByIds` in `src/indexer/db.ts`), the feedback event pipeline (`akm feedback`), and the utility-sorted improve loop ordering are foundational infrastructure that positions akm to implement MemRL-style two-phase retrieval without an architectural rewrite. MemRL (arXiv 2601.03192) is the 2025 state of the art for utility-scored memory retrieval; akm's SQLite schema is already the right shape. The loop is not yet closed — that is a P0 item below.

---

## Confirmed Gaps and Recommendations

Prioritized by ROI (impact × effort), with the highest-return, lowest-risk items first.

---

### P0 — Days effort, immediate unlock

#### P0-A: Unblock high-utility zero-feedback assets from the improve loop

**What:** Include assets with high retrieval utility scores (but zero explicit feedback events) as eligible candidates in the improve pipeline, not just assets that have received `--positive` or `--negative` signals.

**Evidence:** MemRL (arXiv 2601.03192) demonstrates that utility scores — derived from retrieval frequency and downstream task success — are more informative promotion signals than binary feedback alone because they capture implicit usage at scale. The existing `getUtilityScoresByIds` function already computes these scores from retrieval events.

**Current akm behavior:** In `src/commands/improve.ts` lines 338–345, the signal filter retains only refs where at least one `feedback` event has `metadata.signal` or `metadata.note` set. Assets with zero feedback events — which is the majority of most stashes — are silently excluded from every improve run, regardless of how frequently they have been retrieved and used.

**Proposed change:** In `akmImprove` (`src/commands/improve.ts`, around line 338), add a secondary eligibility path alongside the existing signal filter: after collecting signal-bearing refs, call `getUtilityScoresByIds` on the remaining zero-feedback refs and include any with a utility score above a configurable threshold (e.g., `utilityScore >= 0.6` or `retrievalCount >= 3`). The `shouldDistillMemoryRef` gate in line 221 can remain unchanged — this is only a filter-widening change in the caller.

**Expected impact:** The majority of high-value assets in any deployed stash currently never enter the distill pipeline. This change enables episodic→semantic promotion for assets that are demonstrably useful (high retrieval count) even when users have not explicitly thumbs-up'd them. The improve loop processes the actual stash rather than the small biased subset that received explicit feedback.

---

#### P0-B: Close the utility score feedback loop after retrieval

**What:** Update utility scores in SQLite after each retrieval event, so scores reflect actual usage outcomes rather than a static initial value.

**Evidence:** MemRL (arXiv 2601.03192) uses the formula `utility += learning_rate × (reward − utility)` after each retrieval. This causes distractor memories — assets that look semantically similar but consistently fail to help — to trend toward zero utility and fall out of retrieval ranking. Without this update loop, utility scores become stale and stop discriminating useful from useless assets.

**Current akm behavior:** Utility scores are stored in SQLite and used in `akmImprove` (around line 544) for improve loop ordering. They are not updated when a retrieval result is used or ignored. The score assigned at indexing time remains the score forever.

**Proposed change:** In the `akm curate` / `akm show` retrieval path, after returning results, write a lightweight retrieval event to `events.jsonl` that records which refs were returned and whether the caller issued a positive or negative follow-up signal. In `src/indexer/db.ts`, add an `updateUtilityScore(ref, reward, learningRate)` function implementing the MemRL formula. Call it during the next `akm index` run (or immediately in a non-blocking async write) for each ref that received a retrieval event since the last update.

**Expected impact:** Retrieval results improve over time without model changes. Assets that are frequently retrieved but never useful sink in ranking; assets that reliably help agents surface higher. This also feeds better inputs into P0-A (the utility threshold filter).

---

#### P0-C: Require `--reason` for negative feedback (not for positive)

**What:** Make `--reason` a required flag on `akm feedback --negative` so that negative feedback events always carry a verbal explanation; leave `--positive` as optional (binary signal is sufficient for positive reinforcement).

**Evidence:** Reflexion (Shinn et al., NeurIPS 2023) demonstrates +8% absolute improvement on AlfWorld sequential decision tasks by converting binary failure signals into verbal summaries before storage — the verbal critique, not the binary flag, is what drives distill quality. The asymmetry is correct: the Rich Feedback Loops pattern (88 Claude Code session analysis) shows that positive feedback captures are most valuable as volume signals; requiring verbose justification for positive feedback reduces capture rate without adding signal quality. Reflexion uses verbal critique *on failure*, not on success.

**Current akm behavior:** In `src/cli.ts` (line 1163), `note` is defined as `type: "string", description: "Optional note to attach to the feedback"`. Both `--positive` and `--negative` accept an optional note. In practice, notes are rarely provided for either signal type. In `src/commands/reflect.ts` line 105, the distill prompt receives `[negative]` with no text when no note is present — an uninformative gradient.

**Proposed change:** In `src/cli.ts`, change the `feedbackCommand` argument parsing: when `args.negative === true` and `args.note` (or a new `--reason` flag) is absent or empty, throw `UsageError("Negative feedback requires --reason. Example: akm feedback skill:deploy --negative --reason 'Suggested wrong flag for git push'")`. Leave the `--positive` path unchanged. Rename `--note` to `--reason` across both paths for consistency with the `akm reject` command (which already uses `--reason` as a required field at line 2858).

**Expected impact:** Every negative feedback event reaching `readRecentFeedback` in `src/commands/reflect.ts` will carry a verbal gradient. The distill LLM receives "why this failed" rather than only "this failed." Positive feedback capture rate is preserved (no new friction). This is the Reflexion insight operationalized in the CLI.

---

### P1 — Days effort, significant improvement

#### P1-A: Volume-based consolidation trigger for `memory:` tier

**What:** Trigger a lightweight deduplication pass in the `memory:` namespace when the count of unreviewed `memory:` assets exceeds a configurable threshold (default: 100).

**Evidence:** CrewAI and MemClaw production deployments use ~100 memories per namespace as a soft consolidation trigger. MemOS (arXiv 2507.03724) formalizes the principle: consolidation should run before quality degrades from volume accumulation, not after. The 2025 memory survey identifies volume-based triggers as one of three required trigger classes (time-based, volume-based, event-based), with no single trigger class sufficient alone.

**Current akm behavior:** `akmConsolidate` in `src/commands/consolidate.ts` is called at the end of every `akmImprove` run (line 459 of `improve.ts`). `improve` runs on a nightly schedule by operator configuration. Additionally, `akmConsolidate` returns immediately at lines 316–329 of `consolidate.ts` if the `memory_consolidation` feature flag is not enabled — meaning consolidation is a no-op in the default configuration for every deployment that has not explicitly opted in.

**Proposed change:** In `akmImprove` (`src/commands/improve.ts`), before the main improve loop, query the count of `memory:` assets in the index. If `memoryCount > threshold` (configurable, default 100), set a local flag that forces `akmConsolidate` to run at the end of the improve run regardless of the nightly schedule. Separately, consider changing the `memory_consolidation` feature flag default from `false` to `true` when an LLM connection is configured (the flag is off by default as a safety gate for deployments without LLM access; that safety property is preserved by the LLM connectivity check).

**Expected impact:** Deployments that accumulate `memory:` assets without a configured nightly schedule will still receive periodic consolidation cleanup, preventing unbounded growth and the quality degradation that accompanies it.

---

#### P1-B: Soft-invalidation for `memory:` deletes in consolidation

**What:** When consolidation identifies a `memory:` asset to delete (because it is contradicted by or subsumed in another), move it to `.akm/archive/` with `status: superseded` and `superseded_by: <ref>` frontmatter instead of hard-deleting it.

**Evidence:** Both mem0 (Mem0g variant) and Zep (arXiv 2501.13956) use soft-invalidation as their standard deletion mechanism: edges are marked `invalid` with a timestamp, not removed. The 2025 memory survey names "archive rather than delete" as the universal best practice: "Mark as INVALID rather than deleting, ensuring contradictory information is resolved and audit trails are preserved." Hard deletion destroys the ability to answer "what did the system believe at time T?" — a question that becomes important when debugging why an agent made a wrong decision.

**Current akm behavior:** In `src/commands/consolidate.ts` lines 580–592, `delete` operations from the consolidation LLM plan result in the file being backed up to `.akm/consolidate-backup/<timestamp>/` and then removed from the primary stash directory. The backup is recoverable manually but is not indexed, not queryable, and not linked to the asset that superseded it.

**Proposed change:** In `src/commands/consolidate.ts`, replace the file-delete path with an archive path: (1) Copy the asset to `.akm/archive/<ref>/` (creating the directory if needed). (2) Add `status: superseded`, `superseded_by: <replacement-ref>`, and `superseded_at: <ISO-date>` to the archived file's frontmatter. (3) Remove from the primary stash index. The existing `.akm/consolidate-backup/` mechanism can remain as a raw snapshot; the archive adds queryability. This is scoped to `memory:` tier; `skill:`, `command:`, and `workflow:` assets are already explicitly deprecated via version control rather than consolidation delete.

**Expected impact:** Belief transition history is preserved and queryable. Debugging why an agent acted on outdated information becomes possible. No data loss from consolidation runs. The archive becomes the foundation for future temporal staleness queries.

---

#### P1-C: `akm remember` returns top-K similar existing memories (in-session deduplication)

**What:** After writing a new `memory:` asset, have `akm remember` return the top-3 semantically similar existing `memory:` assets in its CLI output, so an agent calling `akm remember` mid-session can decide whether to write a new memory or update an existing one.

**Evidence:** The debater analysis identified this as the CLI-compatible alternative to MemGPT's in-loop self-editing (arXiv 2310.08560). MemGPT's core contribution is that agents can assess memory relevance *in context* rather than relying on an external retrieval system after the fact. A CLI version of this — returning similar existing memories at write time — achieves the core benefit (preventing duplicate or contradictory writes) without requiring a persistent stateful server. This is a Days-scale change versus the Months-scale cost of porting MemGPT's architecture to a CLI model.

**Current akm behavior:** `src/commands/remember.ts` writes the new memory asset and exits. The `akmRemember` function enriches the frontmatter (tags, description, `observed_at`) via LLM call but does not perform any similarity search against the existing stash. The output object in `src/cli.ts` line 1232 returns `{ ok: true, ref, signal, note, tags }` with no similar-memory context.

**Proposed change:** In the `remember` command handler in `src/cli.ts` (after the file write succeeds), call `akmCurate` or the vector search path with the new memory content as the query, scoped to `memory:` assets, returning top-3 results. Include these in the CLI output under a `similar` key: `{ ok: true, ref, similar: [{ ref, title, similarity }] }`. The agent calling `akm remember` in its reasoning loop receives the similar-memory list in the response and can decide in-session whether to delete the new asset and update the existing one instead.

**Expected impact:** Duplicate `memory:` accumulation is reduced without requiring a separate consolidation run. Agents using `akm remember` as a mid-session tool call get MemGPT-like deduplication awareness without architectural changes to akm's stateless CLI design.

---

### P2 — Weeks effort, architectural enhancement

#### P2-A: Temporal staleness for `memory:` tier via frontmatter TTL

**What:** Add optional `valid_until` and `reviewed_at` fields to `memory:` frontmatter; add a staleness check in the improve pipeline that flags `memory:` assets older than a configurable TTL as candidates for consolidation review rather than automatic promote.

**Evidence:** Zep (arXiv 2501.13956) achieves 18.5% accuracy improvement and 90% latency reduction on LongMemEval using bi-temporal edges. The pragmatic subset of this — TTL-based staleness flagging — is the approach used by MemOS's archival transition stage and AWS AgentCore's recency-weighted relevance scores. Full bi-temporal modeling (four timestamps per fact) is months-scale overkill for akm's use case; TTL + soft-invalidation is a pragmatic weeks-scale implementation that captures 80% of the benefit.

**Current akm behavior:** Only `createdAt` is tracked on `memory:` assets. There is no `valid_until`, no `reviewed_at`, and no staleness check anywhere in the improve or consolidation pipeline. Memories from 2024 compete on equal footing with memories from this week at retrieval time.

**Proposed change:** Scoped to `memory:` tier only — do not apply TTLs to `skill:`, `command:`, `workflow:`, or `knowledge:` types (those become outdated via event-driven conditions, not time passage). In `src/commands/remember.ts` (`buildMemoryFrontmatter`), add an optional `valid_until` field (ISO date, defaults to `undefined`). In `akmImprove` (`src/commands/improve.ts`), during the `loadMemoriesForSource` phase, flag `memory:` assets whose `createdAt` exceeds a configurable staleness threshold (default: 180 days) and add them to the consolidation candidate list for human review — not automatic deletion. The consolidation phase (P1-B) then handles the actual archive/supersede logic.

**Expected impact:** Old `memory:` assets that may describe outdated states of the world are surfaced for human review before they generate incorrect lesson candidates. The improve loop processes a stash that is more likely to reflect current reality, improving distill output quality.

---

#### P2-B: LLM-as-judge quality gate after lesson lint in distill pipeline

**What:** After `lintLessonContent` passes in `akmDistill`, run a second LLM call that scores the proposed lesson on novelty, actionability, and non-redundancy relative to the source asset and existing lessons of the same type. Only lessons scoring above a threshold enter the proposal queue.

**Evidence:** ExpeL (arXiv 2308.10144) validates rules of thumb by requiring them to explain the success/failure differential between contrasting trajectories — a rule that only explains successes is not accepted. The Self-Evolving LLM Memory Extraction (2025) paper evaluates whether new lessons cause regression on existing clusters before accepting them. The workflow evals pattern (Larson 2025) requires both automated objective metrics and LLM-as-judge. Currently, akm's only automated gate is a structural lint check — a lesson with `description: "x"` and `when_to_use: "y"` passes regardless of quality.

**Current akm behavior:** In `src/commands/distill.ts` lines 462–488, `lintLessonContent` checks that `description` and `when_to_use` frontmatter fields are non-empty strings. This is a structural gate, not a quality gate. The proposal queue and human review process is the current quality backstop, but it processes all structurally-valid proposals without filtering.

**Proposed change:** In `akmDistill` (`src/commands/distill.ts`), after `lintLessonContent` passes, add a second call to `chatCompletion` (the same LLM path already used for distill generation) with a judge prompt that evaluates the proposed lesson against three criteria: (1) Is this lesson meaningfully different from the source asset's existing content? (2) Is the lesson actionable — can an agent follow it without additional context? (3) Is this lesson redundant with an existing `lesson:` asset in the stash (pass top-3 similar existing lessons as context)? The judge returns a float score 0.0–1.0. Proposals scoring below a threshold (e.g., 0.5) are logged to `.akm/distill-rejected/` for debugging but not added to the proposal queue. This reduces proposal queue noise, not the human review gate — human review remains for all proposals that pass.

**Expected impact:** The proposal queue contains higher-quality candidates, reducing reviewer fatigue. The distill loop produces lessons that are novel and actionable rather than near-duplicates of existing content. The LLM judge is fast (single call, small context) and the cost is bounded by the existing improve budget.

---

#### P2-C: Automatic episodic extraction into `memory:` tier from session end (`memory:` tier only)

**What:** Add a session-end hook that spawns an LLM extraction call over recent conversation context and writes raw candidate observations as draft `memory:` assets to a staging area for human review before entering the stash.

**Evidence:** The Self-Identity Accumulation dual-hook pattern (SessionEnd extraction → user-reviewable file) is the most production-validated implementation of hybrid automatic/manual ingestion. mem0 (arXiv 2504.19413) extracts candidate facts from M=10 recent messages per session. A-MEM (NeurIPS 2025) creates atomic notes automatically. The research consensus treats session-boundary extraction as the appropriate trigger for `memory:`-tier capture — not inline during reasoning (which requires a persistent daemon).

**Current akm behavior:** `akm remember "<text>"` is the only ingestion path for `memory:` assets. No hook or session-boundary trigger exists. Capture depends entirely on user discipline.

**Scope constraint:** This recommendation is scoped to `memory:` tier only. Automatic extraction for `skill:`, `command:`, `workflow:`, and `knowledge:` types has no validated research basis for curated procedural content and carries confirmed quality-degradation risk. The debater's Challenge 7 is correct: no published study demonstrates quality improvement from automatic extraction into procedural memory tiers.

**Proposed change:** Create a `hooks/session-end-memory-extract.sh` (or TypeScript equivalent) that: (1) Reads the last N=10 assistant + user turns from the session transcript (mechanism depends on host agent SDK — Claude Code hooks provide session context). (2) Calls `akm remember --draft "<observation>"` for each candidate extracted by the LLM, writing assets to `.akm/memory-staging/` rather than the live stash. (3) Users or operators review staging candidates with `akm proposal list --source staging` before promoting. The existing proposal queue is the promotion gate — the new piece is the extraction front-end. akm's human-in-the-loop safety property is preserved: no automatic extraction writes directly to the live stash.

**Expected impact:** Capture rate for implicit observations (things the agent learned during a session but no one typed `akm remember` for) increases substantially. The stash grows richer without sacrificing curation quality. This closes the "discipline tax" gap relative to mem0 and A-MEM for the `memory:` tier specifically.

---

### P3 — Months effort, major capability addition

#### P3-A: MemRL two-phase retrieval (semantic filter → utility re-rank)

**What:** After the P0-B utility score feedback loop is closed, implement MemRL-style two-phase retrieval: first pass retrieves the top-K semantically similar assets (existing FTS5 + vector path), second pass re-ranks that candidate set by utility score to filter out distractor assets.

**Evidence:** MemRL (arXiv 2601.03192) demonstrates that two-phase retrieval materially reduces distractor memories — assets that score high on semantic similarity but historically fail to help. This is only meaningful once utility scores are being updated from retrieval outcomes (P0-B prerequisite). Without the feedback loop closed, static utility scores provide weak re-ranking signal.

**Current akm behavior:** Retrieval uses FTS5 full-text search and vector embedding search in a hybrid configuration. Utility scores exist in SQLite but are not used in the retrieval ranking path — only in the improve loop ordering.

**Proposed change:** In the `akmCurate` / `akm search` retrieval path, after the first-pass FTS5 + vector results are collected, apply a utility-score re-ranking step that reorders results by `utility_score × semantic_score` (or a weighted combination). The implementation point is in `src/commands/curate.ts` or the underlying indexer search function. The MemRL threshold parameter (`semantic_score >= minimum_threshold`) filters candidates before re-ranking to avoid computing utility scores for clearly irrelevant results.

**Prerequisite:** P0-B (utility score feedback loop) must be implemented first. Without live utility score updates, this adds complexity with minimal benefit.

**Expected impact:** Retrieval precision improves for agents that use `akm curate` repeatedly. Assets that look relevant but consistently fail to help (distractors) sink in retrieval ranking over time without manual curation. This is the foundation of the MemRL performance gains cited in the evidence base.

---

## Rejected Recommendations (Scope-Mismatched)

### CoALA four-tier cognitive hierarchy applied to akm asset types

**What was considered:** Restructuring akm's ten typed asset types into the CoALA episodic → semantic → procedural → working hierarchy with tier-specific decay and retrieval routing.

**Why rejected:** CoALA (arXiv 2603.04740) is designed for *agent self-state* — tracking what an agent experienced, inferred, and learned about itself. akm's types are *tool and knowledge artifact categories* for a knowledge base manager. A `skill:` is not procedural memory in the cognitive science sense; it is a deployable instruction document. Mapping akm's types onto CoALA's hierarchy produces a category error (e.g., `command:` and `workflow:` would both be "procedural," but they are meaningfully distinct categories in akm). akm already has a functional hierarchy for its use case — the typed system is the right organizing principle for a tool library.

### MemGPT-style in-loop self-editing via persistent daemon

**What was considered:** Exposing akm memory operations as tool calls available to agents during their reasoning loop, with a persistent akm server managing context pressure.

**Why rejected:** MemGPT/Letta's in-loop self-editing (arXiv 2310.08560) requires: (1) a persistent stateful session that spans the entire agent reasoning process, (2) a context window that the system manages, and (3) a single agent instance running continuously. akm is a CLI tool: each invocation is independent, stateless, and exits. akm's composability — files on disk, ephemeral index, spawnable as subprocess — is what makes it work with Claude Code, OpenCode, Cursor, and other agent hosts. Making akm a persistent daemon breaks that composability and every other property identified as competitive advantages. The CLI-compatible alternative (P1-C: `akm remember` returning similar existing memories) achieves 70% of the core benefit at a fraction of the cost.

### Full automatic extraction for skill/command/workflow/knowledge tiers

**What was considered:** Running LLM-based extraction from conversation context to automatically generate `skill:` and `knowledge:` assets, as mem0 and A-MEM do for personal facts.

**Why rejected:** The research literature has no validated approach for automatic extraction of *curated procedural knowledge*. Every paper cited in support of automatic extraction (mem0 arXiv 2504.19413, A-MEM NeurIPS 2025, Self-Identity Accumulation) studies extraction of personal episodic facts from conversation streams. The patterns research file (§ "Gaps in Current Thinking," Gap 6) explicitly identifies procedural memory lifecycle as unstudied: "largely treated as a software engineering problem (git, version control) rather than an agent self-improvement problem." akm's manual authorship for `skill:`, `command:`, `workflow:`, and `knowledge:` types is the current state of the art for this asset category, not a gap relative to it.

### Ebbinghaus forgetting curve decay applied to skills and commands

**What was considered:** Implementing time-based Ebbinghaus decay (`strength = importance × e^(−λ_eff × days) × (1 + recall_count × 0.2)`) across all akm asset types to model knowledge staleness.

**Why rejected:** Ebbinghaus decay is calibrated on personal episodic facts from multi-month personal conversation histories (MemoryBank 2023, YourMemory 2024, tested on LoCoMo benchmark). A correctly authored `skill:deploy` does not become less relevant because it was not recently accessed — it becomes outdated when the underlying deployment toolchain changes. Time-based decay applied to a skill would cause akm to progressively de-prioritize a correct, high-quality skill simply due to low access frequency, which is the opposite of correct behavior for a curated knowledge library. Temporal modeling for `memory:` assets is appropriate (see P2-A); time-based decay for procedural assets is not.

### Full bi-temporal modeling (four timestamps per asset)

**What was considered:** Implementing Zep's bi-temporal model (arXiv 2501.13956) with `valid_from`, `valid_until`, `created`, and `expired` timestamps on every asset edge.

**Why rejected:** Zep's bi-temporal model is designed for a knowledge graph where individual entity-relationship edges need independent validity windows. akm stores whole markdown files, not individual graph edges. The cost (schema change, query complexity, migration of existing assets) is months-scale for a problem that TTL + soft-invalidation (P1-B, P2-A) solves at weeks-scale for akm's actual storage model. The `status: superseded` + `superseded_by: <ref>` frontmatter fields capture the essential benefit — preserving audit trail when a fact is contradicted — without requiring a graph database or a timestamp on every field.

---

## Open Research Questions

These are areas where the field has no consensus and akm should monitor rather than implement.

### Episodic-to-semantic promotion criteria

The field agrees that raw observations should be promoted to reusable lessons when patterns emerge across multiple observations, but there is no consensus on *when* or *how* to make this determination reliably. MemTier (2025) identifies this as "the primary retrieval bottleneck." Current approaches (LLM summarization, cosine similarity clustering) are fragile and hard to validate. The distill command is akm's promotion mechanism — its quality depends directly on the distill LLM's judgment, which is not formally evaluated. The LLM-as-judge gate (P2-B) is the best available mitigation, but it is not a solution to the underlying promotion-criteria problem.

### Self-reinforcing error detection and correction

Multiple sources flag this as the central unresolved risk in automated memory systems: if a memory encodes a wrong belief, the agent may never collect evidence to overturn it. mem0 names it as an open gap. MemRL's utility decay partially addresses it (wrong memories eventually de-prioritize), but an agent that never retrieves a bad memory will also never downvote it. akm's human-gated proposal queue is currently the strongest available mitigation, but it only intercepts new proposals — it does not scan the existing stash for self-reinforcing errors that have already been committed. No production-validated solution exists for this in any reviewed system.

### Procedural memory lifecycle (skill versioning and staleness detection)

How agents should autonomously detect that a `skill:` has become outdated and safely deprecate it has no established pattern in the research literature (patterns research §F, Gap 6). Current practice treats this as a software engineering problem (git history, semantic versioning, explicit deprecation notices). Event-driven invalidation — where a CI failure or tool API change triggers an `akm feedback skill:X --negative --reason "deprecated API"` signal — is the most practical available approach, but it requires the agent or CI system to recognize the staleness trigger, which is itself an open problem.

### Feedback signal accuracy validation

The field knows richer feedback is better, but there is no standard method for validating whether a feedback signal is *accurate*, not just rich. A detailed but wrong verbal critique (e.g., misdiagnosing why a skill failed) is worse than binary correct feedback. The grader design problem in Agent RFT (OpenAI 2025) is a symptom of this: Rogo Finance required multiple grader redesigns after discovering reward gaming from misspecified graders. For akm, this manifests as: how do we know that the `--reason` text on a negative feedback event correctly identifies the actual failure cause? This is an active research gap with no validated solution.

### LLM-judge non-determinism for memory quality gates

The workflow evals pattern (Larson 2025) acknowledges that LLM evaluator non-determinism makes quality gates fragile: "most runs are in between pass and fail." If the P2-B LLM-as-judge gate is implemented, its threshold and retry policy need to account for evaluator variance. The field has no standardized approach for establishing a reproducible quality baseline when both the generator (distill) and the evaluator (judge) are stochastic. Statistical mitigation (run judge 3×, accept if majority pass) adds cost and has not been standardized.

---

*Report synthesized by Claude Sonnet 4.6 from four research and debate documents. No project source files were modified during analysis. All citations are traceable to the source documents at `/tmp/akm-comparison-research-memory-systems.md`, `/tmp/akm-comparison-research-patterns.md`, `/tmp/akm-comparison-analysis.md`, and `/tmp/akm-comparison-debater.md`.*
