# akm improve — Workflow Reference

`akm improve` is the scheduled self-improvement loop that walks every asset in the stash (or a scoped subset), invokes the reflection agent and the LLM distiller on each one, runs memory consolidation across the corpus, and then performs improve-owned maintenance passes such as memory inference and graph extraction. It is the primary mechanism for turning accumulated feedback signals into queued proposals. Proposal resolution is **audited-autonomous**: in practice proposals are resolved by the pipeline's own gates (auto-accept gate, drain policy, TTL), not by per-item human review — the audit trail (events + resolved proposal rows) is the oversight mechanism. Per-item human approval exists only at `/akm-memory-promote` and `/akm-proposal accept`.

## Command surface

| Option | Type | Purpose |
|---|---|---|
| `--scope` | `string` | Restrict the run to a single ref (`type:name`), an asset type (`lesson`), or omit for all assets. |
| `--task` | `string` | Hint forwarded verbatim to the reflection prompt and agent. |
| `--dry-run` | `boolean` | Compute the plan from the existing index and analyze memory cleanup; emit no events, acquire no lock, call no model, and write nothing. |
| `--target` | `string` | Passed through to `akmConsolidate` as the write-target source override. |
| `--auto-accept` | `number \| "safe" \| false` (default: **off**) | Opt-in threshold for the shared auto-accept gate (`runAutoAcceptGate`). Flag absent or bare `--auto-accept` → OFF (`parseAutoAcceptFlag`; deliberate flip from the 0.8.0-RC default-ON-at-90 behaviour). `--auto-accept=<N>` → integer threshold 0-100. `--auto-accept=safe` → permanent alias for 90. `--auto-accept=false` → explicit disable. Until proposals expose per-operation confidence scores, an enabled gate accepts the consolidate batch whole (legacy behaviour). The drain tier never consults this threshold — it is deterministic-policy-gated. |
| `--limit` | `number` | Cap the number of assets processed after utility-score sorting. |
| `--timeout-ms` | `number` | Wall-clock budget for the entire run. Default: 7 200 000 ms (2 hours). |
| `--consolidate-recovery` | `"abort" \| "clean"` | Recovery mode for stale/incomplete consolidate journals. Default: `abort`. |
| `--require-feedback-signal` | `boolean` | Restrict all/type runs to refs with recent feedback signals; disable retrieval fallback. |
| `--min-retrieval-count` | `number` | Minimum retrieval count for zero-feedback fallback eligibility. Default: 5. |

Injected function seams (`reflectFn`, `distillFn`, `ensureIndexFn`, `reindexFn`) replace production defaults in tests.

## High-level flow

```mermaid
flowchart TD
    A([akm improve invoked]) --> B[resolveImproveScope\nscope mode: all / type / ref]
    B --> C{dryRun?}
    C -- no --> ENSURE[ensureIndex primaryStashDir]
    C -- yes --> COLLECT[collectEligibleRefs\nquery existing SQLite index, filter to stashDir]
    ENSURE --> COLLECT
    COLLECT --> CLEANUP_ANALYZE{memoryCleanup eligible?}
    CLEANUP_ANALYZE -- yes --> ANALYZE[analyzeMemoryCleanup\nscans .derived memories\nPRE-COMPUTED before dryRun check]
    CLEANUP_ANALYZE -- no --> D
    ANALYZE --> D{dryRun?}
    D -- yes --> DRY[Return dry-run result\nno lock, no events, no writes, no model calls\nincludes memoryCleanupPlan analysis]
    D -- no --> E[Lock acquisition\n.akm/improve.lock]

    E --> E1{lock file exists?}
    E1 -- no --> E3
    E1 -- yes --> E2{process still alive?}
    E2 -- yes --> ERR([throw ConfigError: already running])
    E2 -- no / stale --> E3[remove stale lock\nwrite new lock JSON with pid + startedAt]

    E3 --> J[applyMemoryCleanup\npersist belief-state transitions\narchive prune candidates to .akm/archive/]
    J --> K[filterRemovedPlannedRefs\ndrop archived refs from queue]

    K --> L[Signal filter\nkeep only refs with recent feedback events\nhaving metadata.signal or metadata.note]
    L --> L2[Zero-feedback fallback\ninclude refs with retrievalCount >= threshold\ndefault threshold: 5]
    L2 --> M[buildUtilityMap\nlook up utility scores from SQLite]
    M --> N[Sort by utility score DESC\napply --limit if set]
    N --> J2{anything archived or transitioned?}
    J2 -- yes --> J3[push memory-prune actions\nreindexFn: rebuild SQLite index]
    J2 -- no --> O
    J3 --> O[Pre-run validation sweep\ncheck file exists + lesson description]
    O --> P{validationFailures?}
    P -- yes --> P1[Log failures; add to validationFailures set\ncontinue with valid refs only]
    P -- no --> Q

    P1 --> Q

    subgraph ASSET_LOOP["Per-asset loop"]
        Q --> S{ref in validationFailures?}
        S -- yes --> SKIP([skip, next asset])
        S -- no --> R{budget exhausted?}
        R -- yes --> BUDGET([push error action\nbreak loop])
        R -- no --> REFLECT

        subgraph REFLECT["reflectFn subprocess"]
            REFLECT_A[appendEvent: reflect_invoked] --> REFLECT_B[lookup ref in FTS index\nread asset file content]
            REFLECT_B --> REFLECT_C[readRecentFeedback\nbuildSchemaHints for lessons]
            REFLECT_C --> REFLECT_D[buildReflectPrompt]
            REFLECT_D --> REFLECT_E{RunnerSpec kind?}
            REFLECT_E -- sdk --> REFLECT_SDK[executeRunner\nin-process SDK call]
            REFLECT_E -- spawn --> REFLECT_SPAWN[executeRunner\nspawn agent CLI binary\ncaptured stdout]
            REFLECT_SDK --> REFLECT_F
            REFLECT_SPAWN --> REFLECT_F[parseAgentProposalPayload\nextract JSON from stdout]
            REFLECT_F --> REFLECT_G[createProposal\nstash/.akm/proposals/UUID/proposal.json\nsource: reflect]
            REFLECT_G --> REFLECT_H([return AkmReflectResult\nok or failure envelope])
        end

        REFLECT_H --> T{lesson or distillable memory?}
        T -- no --> NEXT_ASSET
        T -- yes + memory without recent feedback
        --> SKIP_WEAK[push distill-skipped action\nappendEvent improve_skipped\nreason: memory_distill_requires_feedback]
        T -- yes --> DEDUP{pending proposal\nalready exists for lessonRef?}
        DEDUP -- yes --> SKIP_DISTILL[push distill-skipped action]
        DEDUP -- no --> DISTILL

        subgraph DISTILL["distillFn subprocess"]
            DISTILL_A[lookup ref file path] --> DISTILL_B[readEvents: feedback for ref\napply excludeFeedbackFromRefs filter]
            DISTILL_B --> DISTILL_C{proposalKind == auto\nAND promotion heuristic passes?}
            DISTILL_C -- yes --> DISTILL_PROMOTE[createProposal knowledge:ref\nsource: distill\nappendEvent: distill_invoked outcome=queued]
            DISTILL_C -- no --> DISTILL_D[tryLlmFeature: feedback_distillation\n30 s hard timeout\nnull on gate-disabled or error]
            DISTILL_D --> DISTILL_E{raw == null?}
            DISTILL_E -- yes --> DISTILL_SKIP[appendEvent: distill_invoked outcome=skipped\nreturn skipped result]
            DISTILL_E -- no --> DISTILL_F[stripMarkdownFences\nlintLessonContent or validateKnowledgeContent]
            DISTILL_F --> DISTILL_G{findings?}
            DISTILL_G -- yes --> DISTILL_FAIL[appendEvent: outcome=validation_failed\nthrow UsageError]
            DISTILL_G -- no --> DISTILL_H[createProposal lesson:slug-lesson\nor knowledge:slug\nsource: distill\nappendEvent: outcome=queued]
            DISTILL_PROMOTE --> DISTILL_RETURN
            DISTILL_SKIP --> DISTILL_RETURN
            DISTILL_H --> DISTILL_RETURN([return AkmDistillResult])
        end

        SKIP_DISTILL --> NEXT_ASSET
        SKIP_WEAK --> NEXT_ASSET
        DISTILL_RETURN --> NEXT_ASSET([completedCount++\nlog progress])
    end

    NEXT_ASSET --> S

    BUDGET --> CONSOLIDATE
    SKIP --> S
    NEXT_ASSET -->|all assets done| CONSOLIDATE

    subgraph CONSOLIDATE_SUB["akmConsolidate subprocess"]
        CON_A{selected strategy processes.consolidate.enabled?} -- no --> CON_NOOP([return empty result])
        CON_A -- yes --> CON_B[checkForIncompleteJournal\nabort if prior run incomplete]
        CON_B --> CON_C[loadMemoriesForSource\nSQLite DB or filesystem fallback\nexclude .derived names]
        CON_C --> CON_D{memories == 0?} -- yes --> CON_NOOP
        CON_D -- no --> CON_E

        subgraph PHASE_A["Phase A — Plan generation (chunked)"]
            CON_E[split into 20-memory chunks\n500-char body truncation] --> CON_F[For each chunk:\ncallAi with CONSOLIDATE_SYSTEM_PROMPT]
            CON_F --> CON_G[parseEmbeddedJsonResponse\nvalidate ops: merge / delete / promote]
            CON_G --> CON_H{2+ consecutive failures?} -- yes --> CON_ABORT[push warning, break]
            CON_H -- no --> CON_F
        end

        CON_ABORT --> CON_MERGE
        CON_G --> CON_MERGE[mergePlans: deduplicate ops\nmerge wins over delete]
        CON_MERGE --> CON_DRY{dryRun?} -- yes --> CON_DRYRESULT([return planned ops, no writes])
        CON_DRY -- no --> CON_HTTP{HTTP path AND autoAccept === undefined\n(--auto-accept=false explicitly passed)?}
        CON_HTTP -- yes --> CON_CONFIRM[promptConfirm: apply N ops?]
        CON_CONFIRM --> CON_CONFIRMED{user answered y?} -- no --> CON_ABORT2([return previewOnly result])
        CON_CONFIRMED -- yes --> PHASE_B
        CON_HTTP -- no --> PHASE_B

        subgraph PHASE_B["Phase B — Write operations"]
            PHASE_B_A[writeJournal .akm/consolidate-journal.json] --> PHASE_B_B[For each op:]
            PHASE_B_B --> PHASE_B_MERGE{op == merge?}
            PHASE_B_MERGE -- yes --> PHASE_B_M1[generateMergedContent\n2nd callAi for synthesis]
            PHASE_B_M1 --> PHASE_B_M2[backupFile secondaries\nwriteAssetToSource primary\ndeleteAssetFromSource secondaries\nmarkJournalCompleted]
            PHASE_B_MERGE -- no --> PHASE_B_DEL{op == delete?}
            PHASE_B_DEL -- yes --> PHASE_B_D1[backupFile\ndeleteAssetFromSource\nmarkJournalCompleted]
            PHASE_B_DEL -- no --> PHASE_B_PRO{op == promote?}
            PHASE_B_PRO -- yes --> PHASE_B_P1[idempotency check:\nlistProposals + fs.existsSync\ncreatePropsal source: consolidate\nmarkJournalCompleted]
        end

        PHASE_B_M2 --> CON_DONE
        PHASE_B_D1 --> CON_DONE
        PHASE_B_P1 --> CON_DONE[cleanupJournal\nreturn ConsolidateResult]
    end

    CONSOLIDATE --> CON_A
    CON_NOOP --> MAINT
    CON_DONE --> MAINT
    CON_DRYRESULT --> MAINT
    CON_ABORT2 --> MAINT

    subgraph MAINTENANCE["Improve-owned maintenance"]
        MAINT[runImproveMaintenancePasses] --> MI{memory refs queued for inference?}
        MI -- no --> GRAPH
        MI -- yes --> MI_RUN[runMemoryInferencePass]
        MI_RUN --> MI_WRITE{wrote derived memories\nor marked parents?}
        MI_WRITE -- yes --> MI_REINDEX[reindexFn\nrefresh SQLite state after inference writes]
        MI_WRITE -- no --> GRAPH
        MI_REINDEX --> GRAPH[runGraphExtractionPass\nafter consolidation and inference settle]
    end

    GRAPH --> FINAL

    FINAL[Assemble AkmImproveResult\nschemaVersion: 1] --> UNLOCK[fs.unlinkSync improve.lock\nfinally block]
    UNLOCK --> RETURN([return AkmImproveResult])
```

## Subprocess detail

### reflect (akmReflect)

`akmReflect` is the agent-invocation subprocess. It always emits a `reflect_invoked` event at entry, regardless of success or failure.

For `skill:*` refs, reflect also reviews related distilled lessons as consolidation evidence. When those lessons show strong, repeatable, factual guidance, the agent may propose promoting that guidance into long-term skill documentation, including companion reference docs under `skills/<skill>/references/*.md` via `knowledge:skills/<skill>/references/<topic>` refs.

**Internal steps:**

1. Emit `reflect_invoked` event via `appendEvent`.
2. Resolve asset content: look up the ref in the FTS index; read the file if found. Index miss is non-fatal.
3. Resolve the selected strategy's `reflect.engine`, falling back to `defaults.llmEngine`.
4. For skill refs, load the canonical derived lesson (`lesson:<type>-<name>-lesson`) plus any lesson files whose frontmatter `sources` cite the skill ref.
5. Build the reflection prompt via `buildReflectPrompt` (see Prompt shape below).
6. Dispatch the frozen `RunnerSpec` through `executeRunner`. Unattended improve
   requires an LLM engine; explicit interactive uses may select an agent engine.
7. Parse stdout: `parseAgentProposalPayload` strips `<think>` blocks and code fences, then JSON-parses the output. Falls back to raw markdown detection if JSON parse fails.
8. Write the proposal: `createProposal(stash, { ref, source: "reflect", payload: { content, frontmatter } })`.

**What it writes:** one durable proposal row in `state.db`. It never writes asset files directly.

**Prompt shape (`buildReflectPrompt`):** The prompt instructs the agent to review the current asset content plus recent feedback signals and return a single JSON object `{ ref, content, frontmatter? }`. When `feedback` is empty and a ref is set, the prompt normally constrains the agent to schema/structural improvements only. The exception is `skill:*` refs with related distilled lessons: in that case the prompt allows substantive changes justified by those lessons and explicitly asks whether durable guidance should stay in `SKILL.md` or be promoted into a companion `knowledge:skills/<skill>/references/<topic>` doc. Lesson refs get a distinct goal framing ("distill what usage signals reveal") versus non-lesson refs ("produce an improved version"). The response contract (`RESPONSE_CONTRACT_JSON`) requires the agent to produce only the JSON object — no prose before or after.

### distill (akmDistill)

`akmDistill` is the bounded in-tree LLM subprocess. It never calls `runAgent`; it issues a direct HTTP chat completion through the configured LLM endpoint. It always emits exactly one `distill_invoked` event.

**Internal steps:**

1. Validate the input ref shape (`parseAssetRef`).
2. Best-effort load asset content via `lookupFn` (defaults to indexer `lookup`).
3. Read feedback events via `readEvents({ ref, type: "feedback" })`. Apply `excludeFeedbackFromRefs` filtering before the LLM sees the events.
4. Memory promotion fast path: when `proposalKind` is `"auto"` or `"knowledge"` and `assessMemoryKnowledgePromotionCandidate` returns `promote: true`, create a `knowledge:` proposal immediately without an LLM call.
5. Resolve `improve.strategies.<selected>.processes.distill.engine` (falling
   back to `defaults.llmEngine`), then issue one bounded call.
   - Process gate: disabled if the selected strategy's `processes.distill.enabled` is `false`.
   - Hard timeout: 600 seconds by default, overridden by the resolved invocation timeout.
   - Returns `null` on gate-disabled, timeout, or error — treated as a graceful skip (exit 0, no proposal).
6. Strip markdown fences and `<think>` blocks from the raw LLM output.
7. Validate: `lintLessonContent` for lesson proposals; `validateKnowledgeContent` for knowledge proposals. Failure emits `distill_invoked` with `outcome: "validation_failed"` and throws `UsageError`.
8. Create proposal: `createProposal(stash, { ref: lessonRef, source: "distill", payload })`.
9. Emit `distill_invoked` event with `outcome: "queued"`.

**Lesson-ref derivation rule:** `lesson:<type>-<name>-lesson` where `<type>-<name>` is derived from the input ref with origin stripped and non-alphanumeric characters replaced by `-`. Example: `skill:deploy` → `lesson:skill-deploy-lesson`.

**What it writes:** one durable proposal row in `state.db`. Never writes asset files directly.

### consolidate (akmConsolidate)

`akmConsolidate` runs after the per-asset loop completes, regardless of how many assets were processed.

**Gate:** returns immediately (no-op result) if the selected strategy's
`processes.consolidate.enabled` is false.

**Phase A — Plan generation:**

1. Check for an incomplete prior journal at `.akm/consolidate-journal.json`; abort if found.
2. Load non-`.derived` memory assets from the SQLite index (filesystem fallback if DB unavailable).
3. Chunk memories into groups of 20 (500-char body truncation). For each chunk, call `callAi` with `CONSOLIDATE_SYSTEM_PROMPT` requesting a JSON plan of `merge` / `delete` / `promote` operations.
4. `parseEmbeddedJsonResponse` extracts and validates each op. After 2+ consecutive chunk failures the loop aborts early.
5. `mergePlans` deduplicates across chunks: merge ops win over delete ops for the same ref; promote ops blocked by a concurrent merge op are dropped with a warning.

**Phase B — Write operations:**

1. Write journal to `.akm/consolidate-journal.json` before any mutations (crash recovery).
2. For each `merge` op: generate merged content via a second `callAi` call, backup secondaries, write merged primary via `writeAssetToSource`, delete secondaries via `deleteAssetFromSource`, mark journal completed.
3. For each `delete` op: backup file, delete via `deleteAssetFromSource`, mark journal completed.
4. For each `promote` op: idempotency check (pending proposals and existing file); `createProposal` with `source: "consolidate"`; mark journal completed.
5. Clean up the journal and timestamp-keyed backup directory on success.

**HTTP path confirmation:** auto-accept is **on by default** (threshold 90) when the `--auto-accept` flag is absent, so Phase B proceeds without prompting. The user is prompted interactively before Phase B executes only when `--auto-accept=false` is explicitly passed on the HTTP path (no agent config). Any other value of `--auto-accept` — including the bare flag, an integer threshold, or the `safe` alias — keeps auto-accept enabled and skips the prompt.

**What it writes:**
- `.akm/consolidate-journal.json` — operation log for crash recovery.
- `.akm/consolidate-backup/<timestamp>/<name>.md` — backup copies of files before delete/merge.
- Modified or deleted memory asset files via `writeAssetToSource` / `deleteAssetFromSource`.
- `<stashRoot>/.akm/proposals/<UUID>/proposal.json` for each `promote` op.

### improve-owned maintenance

After consolidation completes, `akmImprove` runs maintenance steps that own the
remaining live-write memory/index artifacts previously coupled to indexing.

**Memory inference:**

1. Collect the memory refs that completed distill without being promoted to
   `knowledge:` in the same improve run.
2. Call `runMemoryInferencePass` with those refs.
3. If the pass writes derived memories or marks parents with
   `inferenceProcessed: true`, call `reindexFn({ stashDir })` so SQLite/search
   state reflects the new disk state before any later steps run.

**Graph extraction:**

1. Run `runGraphExtractionPass` only after consolidation and any inference
   reindex are complete.
2. Refresh the graph rows in `index.db` against the final post-improve disk
   state so search-time graph boosts do not immediately go stale.
3. Internal partial refresh paths preserve unrelated graph rows rather than
   rebuilding the indexed graph state from only the touched subset.

### Proposal queue

`createProposal` is the single write point used by reflect, distill, and consolidate (promote). It is also used by the memory consolidation promote path in akmConsolidate.

**Filesystem layout:**

```
<stashRoot>/
  .akm/
    proposals/
      <UUID>/
        proposal.json        ← pending proposal
      archive/
        <UUID>/
          proposal.json      ← accepted or rejected proposal
    improve.lock             ← PID + startedAt; removed in finally block
    consolidate-journal.json ← written before Phase B, removed after
    consolidate-backup/
      <ISO-timestamp>/
        <memory-name>.md     ← backup before delete/merge
    memory-cleanup/          ← belief-state transition log (from applyMemoryCleanup)
```

**`proposal.json` shape:**

```json
{
  "id": "<UUID>",
  "ref": "lesson:skill-deploy-lesson",
  "status": "pending",
  "source": "reflect",
  "sourceRun": "reflect-1715000000000",
  "createdAt": "2026-05-11T00:00:00.000Z",
  "updatedAt": "2026-05-11T00:00:00.000Z",
  "payload": {
    "content": "---\ndescription: ...\n---\n\nbody",
    "frontmatter": { "description": "..." }
  }
}
```

Two proposals can share the same `ref` — the UUID directory name prevents filesystem collisions. The dedup guard in `akmImprove` (checking `listProposals(stashDir, { ref: lessonRef })`) skips `akmDistill` when a pending proposal already exists for the derived lesson ref.

## Scope restrictions

`akm improve` and `akm lint` only operate on writable stash sources (sources with `writable: true`). Read-only sources (git, npm, website) are excluded from the candidate set before any other filtering.

## Cooldown pre-filter

Before the per-asset loop, `akm improve` builds Sets of all refs that are currently under cooldown (reflect, distill, consolidation, schema-repair) in a single batch of event reads. This replaces the prior design that issued one `readEvents` query per ref inside the loop. The change eliminates the "reflect cooldown" console spam on large stashes and reduces database round-trips to O(1) reads per cooldown category. Reflect cooldown now bypasses refs with a newer `promoted` event than their last `reflect_invoked` event.

## Strategy process configuration

| Process | Config path | Controls |
|---|---|---|
| `distill` | `improve.strategies.<name>.processes.distill` | Enables distillation and selects its LLM engine/model/request overrides. |
| `consolidate` | `improve.strategies.<name>.processes.consolidate` | Enables consolidation and selects its LLM engine/model/request overrides. |

Improve process selection is resolved once by `resolveImprovePlan`; LLM-only
processes reject an explicit agent engine rather than falling through. With
`--auto-accept` absent, auto-accept uses the selected strategy's threshold.

## Output shape

`AkmImproveResult` (always `schemaVersion: 1`, `ok: true`):

| Field | Type | Description |
|---|---|---|
| `scope` | `{ mode, value? }` | Resolved scope (`all`, `type`, or `ref`). |
| `dryRun` | `boolean` | Whether this was a dry run. |
| `guidance` | `string?` | Human-readable note about memory cleanup when memories are in scope. |
| `memorySummary` | `{ eligible, derived }` | Count of memory assets in scope and count of `.derived` ones. |
| `memoryCleanup` | `ImproveMemoryCleanupResult?` | Analysis (always present when eligible > 0) merged with apply results on a live run. Includes `archived`, `transitionLogPath`, `transitionLogEntries`, and `warnings`. |
| `plannedRefs` | `ImproveEligibleRef[]` | The post-filter, post-cleanup, utility-sorted refs that were (or would be) processed. |
| `actions` | `ImproveActionResult[]?` | Per-asset action record: mode (`reflect`, `distill`, `distill-skipped`, `memory-prune`, `memory-inference`, `graph-extraction`, `error`) and the subprocess result. Absent on dry-run. |
| `validationFailures` | `Array<{ ref, reason }>?` | Refs skipped due to pre-run validation failures (missing file, missing description). |
| `consolidation` | `ConsolidateResult?` | Result from `akmConsolidate`; omitted when `processed === 0` and no warnings. |
| `memoryInference` | `MemoryInferenceResult?` | Improve-owned post-consolidation memory inference telemetry. |
| `graphExtraction` | `GraphExtractionResult?` | Improve-owned post-consolidation graph refresh telemetry: considered/extracted counts, entity/relation totals, quality summary, latest-run graph telemetry (`extractorId`, `extractionRunId`, model, prompt version, batch size, cache hits/misses, truncation count, failure count), and any low-quality warnings. |

## Consolidation Skip Reason Taxonomy

`akmConsolidate` emits structured `skipReasons` entries in its result. Each entry is `{ op, ref, reason }`. The reasons fall into three categories:

### Expected / healthy (not bugs)

| Reason | Meaning |
|--------|---------|
| `merge_participant_blocked` | Hot or unparseable memory was a merge participant. Pre-flight guard fires before LLM call. High counts are normal on stashes with many `captureMode: hot` memories. |
| `captureMode_hot_refused` | Delete refused on a hot memory. Correct behavior. |
| `promote_already_exists` | Target knowledge ref already exists on disk. Normal steady-state noise. |
| `promote_source_too_small` | Source body too short to warrant a promotion proposal. |
| `merge_content_too_short` | Secondary body too short to be a meaningful merge candidate. |
| `dedup_pending_proposal` | Ref already has a pending proposal. Clears as triage drains the queue. |

### Fixed bugs — should be 0 in steady state

| Reason | Root cause | Fix | Regression signal |
|--------|-----------|-----|-------------------|
| `merge_missing_description` | Guard ordering bug: pre-flight hot guard was placed *after* `generateMergedContent()`, so hot memories wasted LLM calls and then failed the description check. | Commit `208fe06`: pre-flight guard before LLM call. | Any non-zero count. |
| `merge_primary_missing` (stale-DB path) | Prior run deleted files but did not reindex; ghost DB entries reached chunk prompts. | Commit `d34bc1a`: pre-flight `fs.existsSync` filter before chunking. | Log line `Pre-flight: filtered N stale DB entries` + `merge_primary_missing` in same run. |
| `merge_primary_missing` (hallucination path) | LLM invented a primary ref not in the loaded pool; `mergePlans()` had no ref-existence check; every real secondary charged with `merge_primary_missing`. | Commit `a853de4`: `mergePlans()` accepts `knownRefs` set; ops with hallucinated primaries dropped pre-execution. | Log line `mergePlans: primary <ref> not in loaded memory pool (LLM hallucination)`. |

### Residual / low-frequency (not bugs at normal rates)

| Reason | Meaning | Normal rate | Investigation threshold |
|--------|---------|-------------|------------------------|
| `merge_primary_missing` (intra-run race) | An earlier op consumed the ref as a secondary; Fix-A (`memoryByRef.delete`) pruned it; a later op's plan used that ref as its primary. Log: `Merge: primary <ref> not found in loaded memories (pruned by prior op this run)`. | 0–2/run | >2/run: investigate chunk plan ordering |
| `merge_primary_file_gone` | Defense-in-depth: file existed at pre-flight but was deleted between pre-flight and Phase B execution. | 0–1/run | >1/run: investigate lock contention |

### Distinguishing `merge_primary_missing` causes at a glance

```
merge_primary_missing spike → check log for:
  "Pre-flight: filtered N stale DB entries"  → stale-DB regression (d34bc1a broken)
  "pruned by prior op this run"              → intra-run race (normal if ≤2)
  "LLM hallucination" (in mergePlans warn)   → hallucination caught, not charged (a853de4 working)
  "merge_primary_file_gone" in skip reasons  → concurrent file deletion
  none of the above + code change            → investigate pre-flight filter / memoryByRef init
```

See `docs/technical/incidents/2026-06-03-merge-primary-missing-taxonomy.md` for full investigation commands and query recipes.

## Reviewed

Reviewed against `src/commands/improve/improve.ts`,
`src/commands/improve/reflect.ts`, and `src/commands/improve/distill.ts`.

**Checked:**
- Diagram branch ordering for lock vs. scope resolution
- Diagram branch ordering for dry-run early-return
- Validation sweep placement relative to the limit filter
- Consolidation placement relative to the per-asset loop
- Maintenance placement relative to consolidation and reindex
- Per-asset loop branch ordering (validation skip vs. budget check)
- Memory cleanup step sequencing (analyzeMemoryCleanup, applyMemoryCleanup, reindexFn)
- Strategy gating for consolidation (`improve.strategies.<name>.processes.consolidate.enabled`)
- Dry-run early-return node completeness
- Budget-exhausted break path
- Mermaid syntax and subgraph labels

**Fixed:**

1. **`analyzeMemoryCleanup` placement (critical accuracy bug):** The original diagram showed `analyzeMemoryCleanup` happening after lock acquisition (`E3 → F → G → H{memoryCleanup eligible?} → I`). In the actual code (`improve.ts` lines 251–253), `memoryCleanupPlan` is computed unconditionally before the `dryRun` check (line 259) and before lock acquisition (line 272). Moved `analyzeMemoryCleanup` to before the `dryRun?` diamond, and updated the DRY node to note it includes the pre-computed analysis.

2. **Per-asset loop branch order (critical accuracy bug):** The original diagram checked `R{budget exhausted?}` before `S{ref in validationFailures?}`. In the code (lines 394–407), the validation skip (`validationFailureRefs.has(planned.ref)`) is evaluated first (`continue` on line 395), and the budget check happens second (line 396). Swapped the order so `S{ref in validationFailures?}` is the first branch in the loop, followed by `R{budget exhausted?}`. Updated all loop-back edges accordingly.

3. **`reindexFn` timing (accuracy bug):** The original diagram placed `J3[reindexFn]` before `K[filterRemovedPlannedRefs]`. In the code, `filterRemovedPlannedRefs` (line 336) and the signal filter/sort/limit steps (lines 338–349) all run before the reindex block (lines 351–368). Moved `reindexFn` and `push memory-prune actions` to after the sort/limit step and before the validation sweep, matching the actual code order.

4. **Post-loop maintenance placement (accuracy bug):** Improve now runs memory inference and graph extraction after consolidation, not before it. The workflow now documents the maintenance stage and the reindex after inference writes.
