# akm improve — Workflow Reference

`akm improve` is the scheduled self-improvement loop that works through the assets with fresh feedback (or a scoped subset), invokes the reflection agent and the LLM distiller on each one, runs memory consolidation across the corpus, and then performs improve-owned maintenance passes such as memory inference. It is the primary mechanism for turning accumulated feedback into queued proposals: a rewrite (reflect) is planned only from negative feedback on an asset, or for an explicit ref, never from a positive signal and never on a proactive cadence. Proposals remain queued until explicit proposal review or the configured drain policy resolves them; events and resolved proposal rows provide the audit trail.

## Command surface

| Option | Type | Purpose |
|---|---|---|
| `[scope]` (positional) | `string` | Restrict the run to a single ref (`[bundle//]conceptId`), an asset type (`lesson`), or omit for all assets. |
| `--task` | `string` | Hint forwarded verbatim to the reflection prompt and agent. |
| `--dry-run` | `boolean` | Compute the plan from the existing index and analyze memory cleanup; emit no events, acquire no lock, call no model, and write nothing. |
| `--bundle` | `string` | The bundle the run improves and writes to, overriding `defaultWriteTarget` and the working bundle. It is the only bundle whose assets the run plans. |
| `--limit` | `number` | Cap the number of assets processed, taken from the salience ranking, highest first (refs routed to distill only come last). |
| `--timeout-ms` | `number` | Wall-clock budget for the entire run. Default: 7 200 000 ms (2 hours). |
| `--skip-if-locked` | `boolean` | If another improve owns the whole-run lock, return an exit-0 no-op result before triage, indexing, events, or sync. Without the flag, contention is a transient error (`IMPROVE_LOCK_HELD`, exit 75). |
| `--require-feedback-signal` | `boolean` | Turn the proactive-maintenance lane off for the run, so only assets with recent feedback are planned. |

Injected function seams (`reflectFn`, `distillFn`, `ensureIndexFn`, `reindexFn`) replace production defaults in tests.

## High-level flow

```mermaid
flowchart TD
    A([akm improve invoked]) --> B[resolveImproveScope\nscope mode: all / type / ref]
    B --> C{dryRun?}
    C -- no --> E[Acquire whole-run lock\n$STATE/locks/&lt;stash&gt;/improve.lock]
    C -- yes --> COLLECT[collectEligibleRefs\nquery existing SQLite index, filter to stashDir]
    E --> E1{lock file held?}
    E1 -- yes, skip-if-locked --> SKIP[Return exit-0 no-op\nno triage, index, events, or sync]
    E1 -- yes, no flag --> ERR([throw TransientError: already running\nIMPROVE_LOCK_HELD, exit 75])
    E1 -- no / stale reclaimed --> PURGE[purgeGracedArchive\ngit-backed bundles only: delete archived\nretirement bytes past RETIRE_GRACE_DAYS]
    PURGE --> TRIAGE[Triage pending proposal backlog]
    TRIAGE --> ENSURE[ensureIndex primaryStashDir\nshared deadline signal]
    ENSURE --> COLLECT
    COLLECT --> CLEANUP_ANALYZE{memoryCleanup eligible?}
    CLEANUP_ANALYZE -- yes --> ANALYZE[analyzeMemoryCleanup\nscans .derived memories\nPRE-COMPUTED before dryRun check]
    CLEANUP_ANALYZE -- no --> D
    ANALYZE --> D{dryRun?}
    D -- yes --> DRY[Return dry-run result\nno lock, no events, no writes, no model calls\nincludes memoryCleanupPlan analysis]
    D -- no --> CONSOLIDATE
    EXTRACT[Session extract\nwhen the strategy enables it: queues proposals\nfrom coding-agent session transcripts]
    EXTRACT --> J[applyMemoryCleanup\nautonomy-gated: persist belief-state transitions\narchive prune candidates to .akm/memory-cleanup/archive/]
    J --> K[projectMemoryCleanup\ndrop archived refs from the planned set]
    K --> J2{anything archived or transitioned?}
    J2 -- yes --> J3[push memory-prune actions\nreindexFn: rebuild SQLite index]
    J2 -- no --> O[Pre-run validation sweep\ncheck file exists + lesson description\nschema repair when enabled]
    J3 --> O
    O --> P{validationFailures?}
    P -- yes --> P1[Log failures; refs that still fail\nare excluded from selection]
    P -- no --> L[Signal delta\nreflect: negative feedback, distill: any signal,\nnewer than the last ledger attempt\nand no hard ledger window]
    P1 --> L
    L --> L2[Proactive maintenance lane:\nonly retrieved or new material,\nmaxPerRun picks, due after dueDays]
    L2 --> M[scoreSalience\nsalience vector per ref: encoding, outcome, retrieval\nutility scores from SQLite seed the outcome term]
    M --> N[Sort by salience rank DESC, no-op dampened\ndrop refs missing on disk\napply --limit if set]
    N --> Q

    subgraph ASSET_LOOP["Per-asset loop"]
        Q{budget exhausted?}
        Q -- yes --> BUDGET([push error action\nbreak loop])
        Q -- no --> REFLECT

        subgraph REFLECT["reflectFn subprocess"]
            REFLECT_A[appendEvent: reflect_invoked] --> REFLECT_B[lookup ref in FTS index\nread asset file content]
            REFLECT_B --> REFLECT_C[readRecentFeedback\nbuildSchemaHints for lessons]
            REFLECT_C --> REFLECT_D[buildReflectPrompt]
            REFLECT_D --> REFLECT_E[callStageOnce on any engine kind\nllm, agent CLI or SDK\nthe reply's JSON Schema is the output schema]
            REFLECT_E --> REFLECT_F{reply valid?\nparseSchemaReflectOutput}
            REFLECT_F -- no, first reply --> REFLECT_R[one repair turn\nshared across refine passes]
            REFLECT_R --> REFLECT_E
            REFLECT_F -- yes --> REFLECT_G[createProposal\nstate.db proposals row\nsource: reflect]
            REFLECT_G --> REFLECT_H([return AkmReflectResult\nok or failure envelope])
            REFLECT_F -- no, after the repair --> REFLECT_X[parse_error, nothing queued]
            REFLECT_X --> REFLECT_H
        end

        REFLECT_H --> T{distillable memory?\nmemory ref, not derived or proposed,\nnot cooled by the signal delta}
        T -- no --> NEXT_ASSET
        T -- yes + memory without recent feedback
        --> SKIP_WEAK[push distill-skipped action\nappendEvent improve_skipped\nreason: memory_distill_requires_feedback]
        T -- yes + flagged wrong since its last edit
        --> SKIP_FLAGGED[push distill-skipped action\nimprove_ledger row: unchanged\nappendEvent improve_skipped\nreason: distill_flagged_wrong]
        T -- yes + only positive feedback without a reason
        --> SKIP_BARE[push distill-skipped action\nimprove_ledger row: unchanged\nappendEvent improve_skipped\nreason: distill_positive_without_reason]
        T -- yes --> DISTILL

        subgraph DISTILL["distillFn subprocess"]
            DISTILL_A[lookup ref file path] --> DISTILL_B[readEvents: feedback for ref\napply excludeFeedbackFromRefs filter]
            DISTILL_B --> DISTILL_C{proposalKind == auto\nAND promotion heuristic passes?}
            DISTILL_C -- yes --> DISTILL_PROMOTE[createProposal knowledge/ref\nsource: distill\nappendEvent: distill_invoked outcome=queued]
            DISTILL_C -- no --> DISTILL_X{lesson already at\nthe target ref?}
            DISTILL_X -- yes --> DISTILL_EXISTS[appendEvent: distill_invoked outcome=skipped\nskipReason lesson_exists, no call, no proposal\nthe loop records unchanged in the ledger]
            DISTILL_X -- no --> DISTILL_D[callStage distill\nplan-resolved runner\n600 s default timeout]
            DISTILL_D --> DISTILL_E{call failed or empty output?}
            DISTILL_E -- yes --> DISTILL_SKIP[appendEvent: distill_invoked outcome=llm_failed\nreturn llm_failed result, no ledger row]
            DISTILL_E -- no --> DISTILL_N{writer found no lesson?\nNONE or decision none}
            DISTILL_N -- yes --> DISTILL_NONE[appendEvent: distill_invoked outcome=skipped\nskipReason nothing_reusable, no proposal, no judge call\nthe loop records unchanged in the ledger]
            DISTILL_N -- no --> DISTILL_F[stripMarkdownFences\nlintLessonContent or validateKnowledgeContent]
            DISTILL_F --> DISTILL_G{findings?}
            DISTILL_G -- yes --> DISTILL_FAIL[appendEvent: outcome=validation_failed\nthrow UsageError]
            DISTILL_G -- no --> DISTILL_J{quality gate judge:\nreusable, non-redundancy, grounding}
            DISTILL_J -- pass --> DISTILL_H[createProposal lessons/slug-lesson\nor knowledge/slug\nsource: distill, gate decision deferred\nappendEvent: outcome=queued]
            DISTILL_J -- mean in the review band --> DISTILL_REVIEW[createProposal, gate decision deferred\nappendEvent: outcome=review_needed]
            DISTILL_J -- any criterion 2 or below, or the mean too low --> DISTILL_REJECT[improve_ledger row, no proposal\nappendEvent: outcome=quality_rejected\nunless a repeated lesson gets an update proposal, step 10]
            DISTILL_PROMOTE --> DISTILL_RETURN
            DISTILL_SKIP --> DISTILL_RETURN
            DISTILL_EXISTS --> DISTILL_RETURN
            DISTILL_NONE --> DISTILL_RETURN
            DISTILL_H --> DISTILL_RETURN([return AkmDistillResult])
            DISTILL_REVIEW --> DISTILL_RETURN
            DISTILL_REJECT --> DISTILL_RETURN
        end

        SKIP_WEAK --> NEXT_ASSET
        SKIP_FLAGGED --> NEXT_ASSET
        SKIP_BARE --> NEXT_ASSET
        DISTILL_RETURN --> NEXT_ASSET([completedCount++\nlog progress])
    end

    NEXT_ASSET --> Q

    BUDGET --> MAINT
    NEXT_ASSET -->|all assets done| MAINT

    subgraph CONSOLIDATE_SUB["akmConsolidate subprocess"]
        CON_A{selected strategy processes.consolidate.enabled?} -- no --> CON_NOOP([return empty result])
        CON_A -- yes --> CON_C[loadMemoriesForSource\nSQLite DB\nexclude .derived names]
        CON_C --> CON_D{memories == 0?} -- yes --> CON_NOOP
        CON_D -- no --> CON_E

        subgraph PHASE_A["Phase A — Plan generation (chunked)"]
            CON_E[split into configured chunks] --> CON_F[For each chunk:\nchatCompletion with frozen consolidate connection]
            CON_F --> CON_G[parse and validate ops:\npromote only]
            CON_G --> CON_H{2+ consecutive failures?} -- yes --> CON_ABORT[push warning, break]
            CON_H -- no --> CON_F
        end

        CON_ABORT --> CON_MERGE
        CON_G --> CON_MERGE[mergePlans: one promotion per\nsource memory, last chunk wins]
        CON_MERGE --> CON_DRY{dryRun?} -- yes --> CON_DRYRESULT([return planned ops, no writes])
        CON_DRY -- no --> PHASE_B

        subgraph PHASE_B["Phase B — Proposal emission"]
            PHASE_B_PRO[For each promote op:\nidempotency and coverage checks,\nthen emitProposal\nsource: consolidate]
        end

        PHASE_B_PRO --> CON_DONE

        subgraph PAIR_PASS["Pair pass (alpha.9), alongside Phase A/B"]
            PAIR_INIT[Initiators: changed-or-new memory,\nflat knowledge or lesson, in retrieval scope]
            PAIR_INIT --> PAIR_CAND[Candidates: k=5 nearest by stored vector,\nsame bundle + memory tier, cosine >= T_pair]
            PAIR_CAND --> PAIR_JUDGE[One LLM call per pair:\nconsolidate-pair.md, 6-label schema]
            PAIR_JUDGE --> PAIR_OUT{judge label}
            PAIR_OUT -- duplicate / subsumed / supersedes --> PAIR_GUARDS[Guards: hot capture, derived parent,\nrejected-pair match, same-run chain]
            PAIR_GUARDS --> PAIR_CONTINUITY[Continuity check R3:\nreplay retired asset's own queries,\nflag continuityRisk, never block]
            PAIR_CONTINUITY --> PAIR_PROPOSE[emitProposal: retire,\nsource: consolidate-pair]
            PAIR_OUT -- overlap / unrelated / contradicts --> PAIR_NOACTION[judged_no_action\nno 7-day timer — content change only]
        end

        PAIR_PROPOSE --> CON_DONE
        PAIR_NOACTION --> CON_DONE
        CON_DONE[return ConsolidateResult]
    end

    CONSOLIDATE --> CON_A
    CON_NOOP --> EXTRACT
    CON_DONE --> EXTRACT
    CON_DRYRESULT --> EXTRACT
    CON_ABORT2 --> MAINT

    subgraph MAINTENANCE["Improve-owned maintenance"]
        MAINT[runImproveMaintenancePasses] --> MI{memory refs queued for inference?}
        MI -- no --> FINAL
        MI -- yes --> MI_RUN[runMemoryInferencePass]
        MI_RUN --> MI_WRITE{wrote derived memories\nor marked parents?}
        MI_WRITE -- yes --> MI_REINDEX[reindexFn\nrefresh SQLite state after inference writes]
        MI_WRITE -- no --> FINAL
        MI_REINDEX --> FINAL
    end

    FINAL[Assemble AkmImproveResult\nschemaVersion: 2 and sync stash] --> UNLOCK[release whole-run lock\nfinally block]
    UNLOCK --> RETURN([return AkmImproveResult])
```

## Subprocess detail

### reflect (akmReflect)

`akmReflect` is the agent-invocation subprocess. It always emits a `reflect_invoked` event at entry, regardless of success or failure.

Reflect changes only an asset's `description`, `when_to_use` and title. The engine replies with those fields (each `null` when it needs no fix), and akm applies them to the asset it read: the body is kept byte for byte, apart from a `# <title>` heading akm adds when the body has none. A reply that changes nothing creates no proposal.

**Internal steps:**

1. Emit `reflect_invoked` event via `appendEvent`.
2. Resolve asset content: look up the ref in the FTS index; read the file if found. Index miss is non-fatal. A file in the write target that is not the one a proposal writes (`<root>/<type dir>/<name>.md`, derived from the ref) is refused here as `unsupported_type`, before any model call: a skill's `references/a.md` is the ref `knowledge/skills/<name>/references/a`, and a proposal for it would create a second file (`file_outside_layout`, #1052).
3. Resolve the selected strategy's `reflect.engine`, falling back to `defaults.llmEngine`.
4. Build the reflection prompt via `buildReflectPrompt` (see Prompt shape below).
5. Dispatch the frozen `RunnerSpec` through `callStageOnce` under the
   model-work tool policy
   ([Engines for unattended model work](../../reference/configuration.md#engines-for-unattended-model-work)).
   The engine may be an LLM or an agent that confines the policy, and every
   kind runs the same iteration (`runReflectIteration`). The JSON Schema of
   the reply (`REFLECT_JSON_SCHEMA`, or the unscoped schema when no ref was
   given) is the request's output schema: `response_format` for an LLM, the
   shared schema instruction at the end of the prompt for an agent (`claude`
   also gets `--output-format json`, which akm unwraps). An agent edits only
   its own scratch directory, so it returns the proposal as its reply, as an
   LLM does. An LLM endpoint that rejects JSON Schema gets the framed-markdown
   contract instead.
6. Validate the reply with `parseSchemaReflectOutput` (`parseFramedReflectOutput` for the framed contract), which strips `<think>` blocks and code fences, then requires exactly the contract's fields: `confidence` and a `frontmatterPatch` of `description`, `when_to_use` and `title` (each a non-empty single-line string, or `null` for no change), plus `ref` when no target was given. A reply that fails gets one repair turn, shared across self-refine passes: the conversation so far, and a request to reformat the reply in the contract (`reflect-output-repair.md`). A reply still invalid fails with `parse_error` and queues nothing. A failed agent or SDK dispatch is reported as it ran, with its exit code and stderr.
7. Apply the patch (`applyReflectPatch`) to the source asset: its frontmatter with the non-null `description` and `when_to_use` set, and its body unchanged. A non-null `title` becomes a `# <title>` heading and one blank line at the top of the body, only when the body has no level-1 heading; otherwise it is ignored. A source that requires a `description` and has none gets one derived from its own text when the patch gave none (#636). A patch that changes nothing (every field `null`, or equal to the source's, and no `description` to derive) is the `no_change` outcome (`reflect_skipped_noop`), as is a source with no content to patch; a result that differs only cosmetically is `reflect_skipped_cosmetic`. Neither creates a proposal.
8. Quality gate (`processes.reflect.qualityGate`, on unless disabled): one judge call scores the revision against the source on **need**, **preservation** and **quality** ([Quality judge](../improvement.md#quality-judge)), and passes it only when every criterion scores 4 or more. A score that does not pass is refused (`quality_rejected`, no proposal). A judge that times out, errors or replies unparseably gives no verdict, and the proposal is deferred for review (`judge-error`, gate `quality-gate`). Before the judge, with the gate on or off, reflect refuses (`quality_rejected`, no proposal, no judge call; the rule is the event's `reflectDefect`) a revision that adds placeholder text (`placeholder_added`: "please confirm", "to be confirmed"; not `TODO`, `TBD` or `FIXME`), talks about its own edit (`meta_commentary_added`: "the feedback says", "this revision") or copies frontmatter into its body (`frontmatter_copied_into_body`: `sources:` or `updated:` lines outside code, a `sources` value). Each rule counts only what the revision adds to its source (`findReflectDefect`), and its wording is a list that `processes.reflect.defectFilter` replaces or, when empty, turns off ([Configuration](../../reference/configuration.md#strategies)).
9. Retrieval regression gate, after a pass on an existing asset: a revision that grades lower on the asset's own retrieval queries is refused ([Retrieval regression gate](../improvement.md#retrieval-regression-gate)).
10. Write the proposal (`mintProposal`). A pass the judge passed is stamped `staged`, and the triage drain accepts it; with the gate off the proposal is minted unstamped for the drain to decide. One made with no judge configured (`no-judge-configured`) is deferred for review (gate `reflect`), and so is one whose judge gave no verdict (`judge-error`). The drain leaves every deferral for a person.

**What it writes:** one durable proposal row in `state.db`. It never writes asset files directly.

**Prompt shape (`buildReflectPrompt`):** The prompt asks the engine to check the asset's `description`, `when_to_use` and title against its body and the recent feedback signals, and to return a single JSON object `{ confidence, frontmatterPatch }`, with `ref` as well when no target was given. Each patch field is a non-empty single-line string, or `null` when it needs no fix. akm applies the patch to the source it read, so a reply names neither the target nor a body. The goal sentence is the same for every asset type. When `feedback` is empty and a ref is set, the prompt says to fix only a missing or broken field and otherwise return `null` for each. The response contract (`reflect-llm-schema-contract.md`, the same for every engine kind) requires the engine to produce only the JSON object — no prose before or after. Non-empty feedback is always preceded by a caveat (`reflect-feedback-framing.md`) framing it as a signal, not a fact to insert: change a field only when it is missing or broken, or claims more than the body covers, and then only to describe what the body covers; feedback about a task the asset never claims to cover, or asking for information the asset lacks, needs no change. Feedback claims a model treated as ground truth were fabricating whole sections asserting details the asset never contained (#952), and the caveat once offered a `TODO: verify …` placeholder, which a model inserted into a memory from a feedback line reporting that `akm show` had failed; a later distill pass then built a lesson on that line (#999). Previously rejected proposals for the ref are listed with the instruction not to propose the same change again.

**Asset content cap:** the asset content section is capped to keep the prompt well under OS ARG_MAX when it travels through CLI argv (agent/SDK runners always use the flat `REFLECT_CONTENT_CAP`, 12 000 chars). The direct-LLM (`kind: "llm"`) path never touches argv, so its cap is instead computed from the resolved engine's `contextLength` (chars-per-token estimate × the reserve actually used by the rest of that prompt, measured per call rather than guessed), halved (the other half is left for the model's reply), and never dropping below the flat floor. When content is truncated, a `REFLECT_TRUNCATION_MARKER` notice is appended after the visible portion (#952).

### distill (akmDistill)

`akmDistill` is the bounded in-tree LLM subprocess. It never calls `runAgent`; it issues a direct HTTP chat completion through the configured LLM endpoint. Past the process gate it emits a `distill_invoked` event carrying the outcome.

**Internal steps:**

1. Validate the input ref shape (`parseRefInput`, `src/core/asset/resolve-ref.ts`).
2. Best-effort load asset content via `lookupFn` (defaults to indexer `lookup`).
3. Read feedback events via `readEvents({ ref, type: "feedback" })`. Apply `excludeFeedbackFromRefs` filtering before the LLM sees the events.
4. Memory promotion fast path: when `proposalKind` is `"auto"` or `"knowledge"` and `assessMemoryKnowledgePromotionCandidate` returns `promote: true`, create a `knowledge:` proposal immediately without an LLM call.
   - A lesson target that already exists is not regenerated: when the stash the proposal is filed in holds a file at the lesson ref (the path accepting it would write), distill returns `skipped` with `skipReason: "lesson_exists"` and a `distill_invoked` event carrying them, before any LLM call, and mints no proposal and stamps nothing on the input. The lesson ref derives from the memory's name, so a second distill of the same memory proposes the same ref, and accepting that proposal replaces the lesson; all 5 such overwrites recorded by the 2026-10-05 review were rejected. A lesson of that name in another bundle is not an overwrite. As for any `skipped` distill, the loop records the input in the improve ledger as `unchanged`.
5. Resolve `improve.strategies.<selected>.processes.distill.engine` (falling
   back to `defaults.llmEngine`), then issue one bounded call.
   - Process gate: disabled if the selected strategy's `processes.distill.enabled` is `false`.
   - Hard timeout: 600 seconds by default, overridden by the resolved invocation timeout.
   - A timeout, an error or empty output returns an `llm_failed` result: a `distill_invoked` event with that outcome, no proposal and exit 0. It is not a ledger attempt, so the ref stays eligible. A disabled process returns `config_disabled` before any event.
   - The prompt carries the memory, its feedback and the lessons, knowledge notes and skills the library already holds near the memory (the top 3 by search, one search per type; `processes.distill.cls.enabled: false` turns them off). The writer is told what a lesson is (a cause and what to do about it, or a rule with its reason) and to state only what the memory and its feedback say.
   - The writer may find no lesson: it answers the word `NONE`, or, in a reply bound to the JSON schema, `decision: "none"` after a one-sentence `reason` written first. A memory that only records what was done, shipped or decided, how a system is set up, the steps of a procedure, or a rule a related asset already states has none. distill returns `skipped` with `skipReason: "nothing_reusable"` and a `distill_invoked` event carrying it (the message holds the writer's reason), mints no proposal and makes no judge call. The loop records the input in the improve ledger as `unchanged`, as for any `skipped` distill. Before this, the prompt and both schemas forced a lesson from every memory: 18 of the 19 memories distilled on 2026-10-05 recorded what was done.
6. Strip markdown fences and `<think>` blocks from the raw LLM output.
7. Validate: `lintLessonContent` for lesson proposals; `validateKnowledgeContent` for knowledge proposals. Failure emits `distill_invoked` with `outcome: "validation_failed"` and throws `UsageError`.
8. Quality gate (`processes.distill.qualityGate`, on unless disabled): one judge call, on distill's engine or the gate's own (`qualityGate.engine`), scores the lesson from 1 to 5 on **reusable**, **non-redundancy** and **grounding**. It is shown what the writer was shown: the source body the lesson was generated from (frontmatter stripped, first 3000 characters), the feedback that carries a reason or a note, and the lessons, knowledge notes and skills nearest the lesson (top 3, 600 characters each).
   - **Reusable** asks for a rule an agent can use on another occasion, with the reason it holds; 1–2 for a lesson that only records what was done, shipped, decided or is pending, or how a system is set up now.
   - **Non-redundancy** asks whether the lesson is new next to the assets listed, never the source memory (a lesson that restates its source is judged on the other two criteria); 1–2 when a listed asset already states the same rule, or most of what the lesson says in broader words; 5 when none is listed.
   - **Grounding** asks whether every cause, step, number, rule and limit in the lesson is stated by the source or its feedback; 4–5 when each is, 3 when one stretches what the source says, 1–2 when any is in neither, when the lesson drops a limit the source states, or when it is about another subject. It is not part of the mean.
   - A criterion at 2 or below is `quality_rejected` whatever the mean is (the reason names the criterion: `grounding 2/5: …`). Otherwise the lesson passes when reusable and non-redundancy both score 4 or more, and a mean of those two of 2.5 or more is `review_needed`. A pass is also queued for a person (step 9), so the rejection is the only thing that keeps a lesson from a reviewer: on 2026-10-05 the old rubric (novelty, non-redundancy, and a grounding that scored 3 for a lesson that "goes beyond the source") passed 10 of the 17 bad lessons, because a lesson that adds to its memory scored as novel. The old novelty question was also the reason the judge rejected a faithful lesson of a lesson-worthy memory. A distill with no source to read (an unindexed ref distilled "from feedback signal alone") gives the judge an empty source, so its lesson is expected to be rejected.
   - `quality_rejected` writes an `improve_ledger` row for the input (30-day distill rejection window) and a `distill_invoked` event carrying `score`, the per-criterion `criteria` and the `reason`. It mints no proposal.
   - `review_needed` mints a pending proposal stamped `deferred` / `quality-gate` for a human; the triage drain leaves it alone. It is the outcome for a non-passing mean of 2.5 or more when no criterion is at 2 or below, a judge that times out or returns something unparseable or incomplete, and a heuristic lesson-quality finding (for example an invalid `description`), which is found before the judge is called.
9. Create proposal: `createProposal(stash, { ref: lessonRef, source: "distill", payload })` through `mintProposal`. A pass is minted `deferred` (gate `quality-gate`, reason `distill-review`) with the judge's per-criterion `scores` and `judgeReason`, for a person: the triage drain and its judgment tier leave it alone, and the improve ledger records `review_needed`. It is never `staged`. On 2026-10-05 the gate had staged 12 lessons and 10 were bad (they restated the memory, claimed what it does not say, or filed a dated status as a lesson); no judge score separated them from the two good ones. A promotion to knowledge that passes is deferred the same way. With `processes.distill.qualityGate` off nothing was judged, so the proposal is minted unstamped for the drain to decide.
10. Emit `distill_invoked` event with `outcome: "queued"`.

**Updating a lesson the memory repeats (#1090):** when the lesson repeats one the library holds, distill extends that lesson instead of only dropping the duplicate. It happens in two places, both with the quality gate on: the judge scored the writer's lesson 2 or below on non-redundancy (step 8), or the writer answered `NONE` (step 5). Either way the update is tried for the related lessons (among the top 3 nearby assets, as for the judge, in the bundle the proposal is filed in) that the writer's `reason`, or the judge's, names by ref or name, or for the only related lesson when it names none. One lesson among several that merely sit near the memory costs no call. A second call shows the writer the memory, its feedback and the candidate lessons' bodies, and asks it to pick the lesson that already states the memory's rule, list in `new_facts` each cause, step, number, limit or consequence the memory states and the lesson lacks (the memory's own incident retold is not one), and return that lesson's whole body with a line added for each; it answers `decision: "none"` when no listed lesson states the rule, when `new_facts` is empty (an update with none is not proposed), or when the memory contradicts a line. Then:

- Every existing body line must still be there (compared by words, in any case and spacing). A body that drops or rewords one is not proposed.
- The extended lesson (existing frontmatter and the whole new body) is judged as one lesson, in one call, by step 8's judge with an edit variant of its rubric: **reusable** and **grounding** read the whole lesson (a line is grounded when the memory, its feedback or the lesson being extended states it), and **non-redundancy** is asked of each added line against the lesson being extended: 1–2 when it only says again what the lesson says (its rule or cause in other words, or the same rule on an example from the memory), 4–5 when it states a fact the lesson lacks, however specific. The lesson being extended is shown to the judge as such, not as an asset the new lesson might repeat. Judging the added lines alone as a new lesson failed `reusable` for a lone fact, and no update passed. A body that adds no line is not proposed; anything short of a judge pass is not proposed.
- The update is a pending proposal on the existing lesson's ref (`source: distill`), the lesson's frontmatter unchanged except that the memory is added to `xrefs`. Its `beforeHash` is the lesson's as read, so accepting it after the lesson changed is refused as stale. It is minted `deferred` (gate `quality-gate`, reason `distill-update`) with the judge's `scores` and `judgeReason`, so the triage drain and its judgment tier leave it for a person. The result and the `distill_invoked` event are `queued` with `proposalRef` set to the lesson and `updatesExisting: true`.
- When nothing is proposed, the outcome is what it was before: `quality_rejected` with the judge's reason after a duplicate lesson, `skipped` / `nothing_reusable` after `NONE`.

**Lesson-ref derivation rule:** `lessons/<type>-<name>-lesson` where `<type>-<name>` is derived from the input ref with origin stripped and non-alphanumeric characters replaced by `-`. Example: `skills/deploy` → `lessons/skill-deploy-lesson`. A lesson already at that ref is never overwritten (see step 4).

**What it writes:** one durable proposal row in `state.db`. Never writes asset files directly.

### consolidate (akmConsolidate)

`akmConsolidate` runs during preparation, before session extraction and the
per-asset loop.

**Gate:** returns immediately (no-op result) if the selected strategy's
`processes.consolidate.enabled` is false.

**Phase A — Plan generation:**

1. Load eligible non-`.derived` memory assets from the SQLite index, minus
   those the improve ledger holds: a memory judged within its 7-day revisit
   window and unchanged since, and a memory whose promotion was accepted or
   rejected and whose body has not changed since (see **Re-eligibility**
   below).
2. Chunk memories using the selected strategy's configured limit. For each
   chunk, call `chatCompletion` with the frozen consolidate LLM connection and
   `CONSOLIDATE_SYSTEM_PROMPT`, requesting a JSON plan of `promote`
   operations (the only op the schema offers; `merge`/`delete`/`contradict`
   were removed in 0.9.17-alpha.1 at `e82eec811` — they had run in
   production up to that commit, then were dropped because they cost
   thousands of completion tokens).
3. Parse and validate each op, then use `mergePlans` to deduplicate conflicts
   across chunks.

**Phase B — Proposal emission:**

1. For each promote op, perform idempotency checks and emit a reviewable
   proposal with `source: "consolidate"`. The checks run cheapest first and
   each records a skip reason: the same knowledge slug or a pending proposal
   for it, an identical body already in `knowledge/` or already pending, and
   then the coverage check (`consolidate/coverage.ts`, #998): the 20
   `knowledge/` docs in the same bundle nearest to the memory by stored vector
   (`getNeighborsByEntryId` scoped to that bundle's knowledge entries, the
   fetch depth the pair pass uses; no similarity floor, only that rank) are
   compared with it, and the memory is skipped as `dedup_covered_by_knowledge`
   when one of them holds at least half of its distinct 5-word shingles. A
   covering doc that ranks lower goes unseen, so the gate removes fewer
   proposals than the rule does against every knowledge doc (122 of 224
   rejected in #998's sample); its recall over the 20 is unmeasured. The rule
   and its evidence are in the module's header comment. With no stored vector
   (semantic search off, or the memory not yet indexed) the check does
   nothing and nothing throws.
2. Record what happened in the improve ledger (see **Re-eligibility** below):
   a memory the model judged and left alone, or that a skip reason turned
   away, gets a `judged_no_action` row; a promotion that failed to persist
   gets none, so the next run retries it.

**What it writes:**
- A durable row in the `proposals` table in `state.db` for each emitted
  `promote` op, partitioned by bundle path.
- An `improve_ledger` row for each memory the pass judged, except a promotion that failed to persist.

**Re-eligibility (#998):** the promote pass keys its ledger row by the source
memory (`memories/<name>`). A memory the model saw and left alone
(`judged_no_action`) or one with a pending proposal is revisited after 7 days,
or at once when the file is edited. An accepted or rejected promotion is
different: the row carries no `next_eligible_at`, and records the body hash
(`contentHash(_, "body")`, frontmatter excluded) the promotion was decided
against, taken from the proposal's `promotionSourceHash`. The memory is
selected again only when its current body hash differs, the same content-driven
rule the pair pass uses. A rejection is therefore no longer re-asked after 7
days, and the memory of an accepted promotion that is still on disk (O1 could
not archive it, or the same text was restored) is no longer eligible again at
once. A promotion decided before the hash was recorded (an older release's
proposal) has no hash to compare, and keeps the old windows. An expired
proposal still waits one day: nobody judged the text.

**Promotion retires its source (O1, alpha.9):** when an `akm proposal accept`
promotes a consolidate `promote` proposal — by a person or by triage
auto-promotion — it archives the source memory, and its `.derived` twin if
one exists, through the same path the pair pass uses below
(`archiveCleanupCandidate`, reason `promoted`, `successorRefs` the new
knowledge ref). A promotion no longer leaves a memory/knowledge duplicate
behind. This runs inside `promoteProposal`, not inside `akmConsolidate`
itself; a failure to archive the source only warns, it does not undo the
promotion.

### consolidate pair pass (alpha.9)

A second pass inside `akmConsolidate`, alongside Phase A/B above, over the
same enabled gate. It replaces nothing the promote pass does; it adds
duplicate, subsumed and superseding retirement, review-gated.

1. **Initiators:** memory (base or `.derived`), flat `knowledge/` or lesson
   assets in the bundle the run writes to, in the retrieval scope, and
   content-eligible: no prior pair-pass ledger row (source
   `consolidate-pair`, kept apart from the promote pass's `consolidate`
   rows), or a row whose recorded body hash differs from the asset's current
   one. Eligibility is purely content-driven — the ledger row carries no
   `next_eligible_at` timer at all for this source, so nothing here "expires"
   on a schedule; see step 5.
2. **Candidates:** each initiator's nearest neighbours by stored vector
   (`getNeighborsByEntryId`, fetching 20 and keeping the first 5 that clear
   every filter below — a few self/twin/bundle/tier misses in a naive top-5
   used to starve an initiator down to zero real candidates), same bundle,
   memory tier only (structured knowledge in subfolders is excluded), minus
   its own `.derived` twin or parent, at cosine >= `T_PAIR` (0.93). An
   initiator with no prior ledger row needs >= `BACKFILL_FLOOR` (0.95)
   instead, UNLESS it is new material — git first-added within
   `NEW_MATERIAL_DAYS` (7) — which judges at the ordinary `T_PAIR`: new
   content earns the same scrutiny as an edit, not the backlog's higher bar.
   "Older"/"newer" for the judge's own A/B labelling comes from one
   `git log --reverse -M --diff-filter=AR --name-status --format=@%ct` per
   run over the whole bundle (first-add time per path, following renames —
   an `A` sets a path's first-add, an `R` carries the old path's first-add
   to the new one, so a rename never misdates a file as newly added), not
   frontmatter or file mtime; mtime is only the fallback for a path git does
   not track, or a bundle with no `.git` directly inside it. At most
   `MAX_PAIRS_PER_RUN` (300) pairs a run, admitted a whole initiator at a
   time rather than by flat cosine rank across all of them: new-or-changed
   initiators first, then the existing backlog by its own best cosine, each
   admitted only if every one of its own candidate pairs fits in what
   remains of the 300 (first-fit, so a smaller initiator further down still
   fits when a larger one ahead of it does not) — an initiator with a
   pending-blocked pair is skipped entirely rather than spending any of the
   budget on a pair that cannot be judged yet.
3. **Judge:** one LLM call per pair (`src/assets/prompts/consolidate-pair.md`)
   through the consolidate process's own engine and concurrency. It first
   lists the durable claims each side alone holds (`onlyInA`, `onlyInB`),
   then labels the pair one of `duplicate`, `subsumed`, `supersedes`,
   `contradicts`, `overlap` or `unrelated`. Each side is shown up to 12,000
   body characters.
4. **Outcome:** `duplicate`, `subsumed` and `supersedes` mint one `retire`
   proposal (source `consolidate-pair`, its own generator — see below) for
   the side that does not survive — never a `captureMode: hot` memory, never
   a `.derived` memory whose parent still exists, never across bundles,
   never when either side already has a pending retire proposal (as the
   retired ref or its successor), and never retiring or reusing as a
   successor an asset already spent earlier in the SAME run (the durable
   half of this last guard is at accept time — step below), and never
   retiring a side the judge listed a claim for. `contradicts`,
   `overlap` and `unrelated` are recorded `judged_no_action` with no
   proposal; `contradicts` is counted in the run report and stays a human
   decision. A retirement (`duplicate`, `subsumed` or `supersedes`) whose
   retired side has nothing listed (a `duplicate` must also have nothing listed
   on the kept side; a subsumed or superseding successor may hold more) and no continuity risk gets a second call
   (`consolidate-pair-check.md`: what does the retired note hold that the kept
   one lacks?); an empty answer stages the proposal (gate `consolidate-pair`,
   reason the judge's label), and the triage drain accepts it under its usual
   `applyMode`. Replay precision was 336/360 (duplicate 0.98, subsumed 0.92,
   supersedes 0.875). Every other retire proposal waits for a person.
5. **Ledger:** a row is written for an initiator only once every one of its
   own candidates was admitted this run (whole-initiator admission in step 2
   makes this an all-or-nothing membership check) AND actually resolved to a
   verdict — a same-run guard dropping a retire-worthy verdict (the chain
   guard in step 4), a failed mint, a failed or never-sent judge call, all
   count as unresolved, not judged — recording its current body hash and an
   outcome of `proposed` or `judged_no_action`. Neither outcome carries a
   timer for this source: only a later body-hash mismatch (step 1) makes the
   initiator eligible again. An initiator left with any candidate not
   admitted, not judged, or dropped gets NO row at all, so the next run
   reconsiders it rather than treating it as settled — real data: night 1
   alone judged 177 `duplicate` verdicts into only 59 proposals before this,
   the other 118 silently abandoned by the same-run chain guard.

   Because that "no row" case regenerates ALL of an initiator's candidate
   pairs next run — including ones already decided — a pair the owner
   already declined (rejected, or accepted then reverted) is never re-minted
   while both sides are unchanged: before the judge is ever called, the same
   ref pair and the same two content hashes (checked in both orientations,
   since it is the judge — not yet run — that would decide which side is
   "retired") are checked against every rejected or reverted
   `consolidate-pair` proposal on record, and a match is counted as a settled
   no-action (so the initiator's row still gets written this run) at no LLM
   cost at all. Those keys follow each proposal's current status: `akm
   proposal reopen` (#997) moves a rejected proposal back to `pending`, so it
   is no longer settled, and while it is pending a pair pass leaves both of its
   documents alone (step 4's pending-retire guard) instead of minting the
   pair a second time.

**Retire proposals (`akm proposal accept`/`revert`):** minted under their own
source, `consolidate-pair` — kept apart from the promote pass's
`consolidate` proposals so a bulk `accept`/`reject --generator consolidate`
never sweeps a retirement, and the reverse (`--max-diff-lines` counts a
retire proposal by its target's own current line count, not its empty
payload). Accepting one first confirms the decision is still fresh — the
successor still exists, and both sides' recorded body hashes still match
their current files — refusing cleanly, not partially applying a decision
something else (an intervening accept, possibly an A→B/B→C chain) made
stale. It then moves the retired asset (and its `.derived` twin) into the
existing `.akm/memory-cleanup/archive/` through the generalized
`archiveCleanupCandidate`, the one retirement encoding (D27) — never
`.akm/archive/`. A `supersedes` proposal first writes the supersede edge on
the older asset (`writeSupersededEdge`), then archives it. `akm proposal
revert` restores the archived file(s), and for the primary asset restores
the EXACT pre-retire bytes recorded at accept (`backupContent`) rather than
re-deriving "undo the edge" from the archived copy — so a pre-existing
human-written edge, YAML comments and key order all survive the round trip.
Accept records its full intent — `backupContent` and which file is about to
move — on the still-pending proposal before moving anything; a crash at any
point after resumes from that recorded intent (skipping whichever file a
tombstone scan shows an earlier, crashed attempt already archived under this
proposal's own id) rather than refusing it as stale or re-deriving
`backupContent` by guessing at what the archived copy would have been.
Revert works the other way for the same reason: each archive dir's own
tombstone already names its original and archived paths, so "original
present, archived copy missing" resumes as an earlier, crashed revert's own
work — UNLESS that original path's current content does not match the
`retirement.retiredContentHash` recorded at accept, meaning the path was
reused by an unrelated file since, which refuses instead of overwriting it.
Triage auto-accepts a `retire` proposal only when the pair pass staged it
(gate `consolidate-pair`, see step 4 above) and `applyMode` allows it; every
other one waits for a person. Review reuses `akm proposal list --generator consolidate-pair` (S4: the
backlog is reviewed as its own list, not mixed in with every other
generator's proposals), `show`, `diff` (which renders a retirement as the
retired file's lines leaving under a `retire` header, with the pair's verdict
and a note that accept archives and revert restores — not as the file replaced
by a blank one, #997), and bulk
`accept --generator consolidate-pair` / `reject --generator
consolidate-pair`. A proposal carrying `continuityRisk` (below) is excluded
from that bulk accept, whatever the generator or `--yes` — visible inline in
`list`'s default output and in the text output of `show` and `diff` (the
specific failing/unverified queries, not just a count) — bulk reject is unaffected,
and a person can always accept one by id. A rejection is not final:
`akm proposal reopen <id>` puts a rejected retire proposal back to `pending`
(refused if the retired document, or the successor, changed since the pair was
judged, or if another pending retire proposal now involves either of them),
and accepting it then archives the file exactly as for any other retire
proposal.

### Retirement continuity check (rule R3)

Before the pair pass mints a `retire` proposal, it replays up to five of the
retired asset's own past `search`/`curate` queries
(`loadRetrievalQueries`, `src/commands/improve/retrieval-gate.ts` — the same
cleaned set the retrieval regression gate replays: `usableRetrievalQueries`
drops stash-README boilerplate and harness/tool envelopes
(`nonTaskInput`), pastes over 2,000 characters, and queries that are
duplicates once whitespace is collapsed, S3a) through akm's own search,
in-process — the same ranking a user gets, no LLM
(`src/commands/improve/consolidate/continuity-check.ts`). For every query
where the retired asset ranked in the top 10, the successor must rank in the
top 10 too — compared directly (N2): search itself returns at most the top
10 hits, so `rankOf` finding the successor among them or not is the whole
comparison, no generic rank-change-report abstraction needed. No recorded
queries means no check and no flag — and so does a retired/successor pair
whose bodies are
content-identical once whitespace is collapsed (S3b): search's own
content-dedupe (`src/indexer/search/db-search.ts`) already hides the
successor behind the retired asset for every such query, so a "successor
missing" finding there would not be a real risk, just that dedupe working
as designed.

A failing query does not block the mint — it flags. The proposal's
`retirement.continuityRisk` records the failing query count and, per failing
query, the retired asset's rank and the successor's (`null` when the
successor did not rank in the top 10 at all). This is the forgetting-safety
lane's old purpose (see below), now measured against search rank instead of
a stash-wide salience rank, and only at the moment an asset would actually
stop resolving.

A query that never ran (the search call threw) or that fell back to
keyword-only ranking (`mode: "fts-fallback"`) is "unverified" (S2): dropped
from the rank comparison — its hits are not the ranking a user actually
gets, so they are never compared — but tracked in
`retirement.continuityRisk.unverifiedQueries`, and on its own enough to set
`continuityRisk` even when every verified query passed. A search failure or
fallback must never look like "no risk found." `createContinuitySearch`
(`src/commands/improve/consolidate/continuity-check.ts`) is stateful across
one pair-pass run: the first `fts-fallback` it sees forces
`semanticSearchMode: "off"` for every later query that same run, so a down
embedding endpoint pays its failed-connection cost once per run, not once
per remaining query.

**The retired forgetting-safety lane.** Before alpha.9, `scoreSalience`
compared the whole stash's salience ranking before and after every improve
run, and a ref that fell from the top 200 to below 500 was injected into that
run's work set under `eligibilitySource: forgetting-safety`
(`applyForgettingSafety`, `improve_salience_rank_change` event). It was a
one-time cutover guard from the June 2026 ranking-formula change, running on
every run since. R5's 30-day event window (2026-08-30 to 2026-09-29, 47
`improve_salience_rank_change` events, 5 refs flagged across 4 runs) found no
marginal pick over the simpler baseline: 4 of the 5 flagged refs were also
picked that same run by the signal-delta lane, and the 5th has no
`reflect_invoked`/`distill_invoked` event in the retained history, but that
run's `improve_runs.plannedRefs` shows it, too, was planned under
`signal-delta` — just not reflected (a dispatch/budget limit that run, not a
lane-exclusive pick). All 5 flagged refs were signal-delta picks; zero were
ever forgetting-safety-only. It also protected `asset_salience.rank_score`,
which only improve itself ever read. Both the per-run comparison and the
injection are gone; so is `buildRankChangeReport` itself (N2 — the
continuity check compares ranks directly, and nothing else called it).
`forgetting-safety` stays a valid `eligibilitySource`/event-type value so
old proposals and events still decode.

### Archive purge sweep (step 8)

A retirement's archived bytes are not deleted when it is accepted — only the
tombstone (`cleanup.md`) resolves the ref from then on. `purgeGracedArchive`
(`src/commands/improve/memory/memory-improve.ts`) deletes them later,
deterministically and with no LLM, once at the very start of every
`akm improve` run — before index bootstrap, before triage. For a git-backed
bundle it walks `.akm/memory-cleanup/archive/`, and for every tombstone whose
`retiredAt` is more than `RETIRE_GRACE_DAYS` (30) days old AND whose
directory is entirely git-tracked and clean (one `git ls-files` plus one
`git status --porcelain -uall` per sweep, not per directory — B1), deletes
the archived asset file(s) under that tombstone's own directory — never
`cleanup.md` itself; git history keeps the bytes (D27). `.git` presence
alone does not prove a retirement was ever committed: `akm proposal accept`
only commits for a `kind: "git"` write target, and improve's own auto-sync
only stages the paths that same run wrote, so a directory with even one
untracked or modified file (the tombstone included) is left whole for a
later sweep rather than losing the only surviving copy of it. A
memory-cleanup family-prune archive (not a pair-pass retirement) has no
`retiredAt` in its tombstone at all, so this sweep never touches that older
archive class.

Every deleted file is journaled individually
(`src/core/write-provenance.ts`), the same mechanism the archive move itself
uses, so the end-of-run auto-sync commits the deletion in the run's own
commit. A bundle with no `.git` of its own is left untouched — there is
nothing to fall back on if a delete turns out to be wrong — and `akm health`
reports its archive's size and file count instead (`memory-cleanup-archive`
advisory, `src/commands/health/archive-usage.ts`), silent whenever the bundle
is git-backed or the archive is empty or absent.

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

### Proposal queue

`createProposal` is the write point used by reflect, distill, consolidate (promote), extract, schema repair and `akm proposal new`; the pair pass's retire proposals go through `createRetireProposal` instead. Both write the canonical `proposals` table in `state.db`; rows are partitioned by `stash_dir`, and pending/accepted/rejected/reverted are statuses on the same durable record (`akm proposal reopen` moves a rejected row back to pending). The retired `<stash>/.akm/proposals/` tree is neither read nor written.

**Logical proposal shape:**

```json
{
  "id": "<UUID>",
  "ref": "lessons/skill-deploy-lesson",
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

Two proposals can share the same `ref`; their UUID primary keys prevent collisions. Nothing in the loop scans the queue before it runs reflect or distill. The improve ledger keeps a stage from proposing the same ref again: an attempt that left a pending proposal is revisited after 7 days, or sooner when feedback newer than the attempt arrives (see **Ledger pre-filter (signal delta)** below).

## Scope restrictions

`akm improve` reads and writes one bundle, its write target: `--bundle`, else `defaultWriteTarget`, else the working bundle. The candidate set is that bundle's assets and nothing else, because every proposal is filed in the write target. An asset that another writable bundle owns is never planned: reflect would read it from its own bundle and the proposal would land in this one, either forking the asset as a `create` or overwriting this bundle's copy with content taken from the other's (#1000). A bare ref scope (`akm improve skills/x`) resolves inside the write target only, and distill's memory-to-knowledge promotion merges only with a doc that already exists there. To improve another writable bundle, select it with `--bundle team` or a bundle-qualified scope such as `team//skills/code-review`; a scheduled run therefore covers only its write target, and each other bundle needs its own scheduled `akm improve --bundle <name>` run. A dry run (`--dry-run`, `--plan`) resolves the bundle the way a live run does, with the working bundle starting from `AKM_BUNDLE_DIR` before `defaultBundle`, so it previews the bundle a live run improves. As a second line of defence, `createProposal` refuses a proposal whose `itemRef` names an asset owned by a different configured bundle than the queue's.

`akm improve` and `akm lint` only operate on writable bundle sources (sources with `writable: true`). Read-only sources (git, npm, website) are excluded from the candidate set before any other filtering; a read-only write target plans nothing.

## Ledger pre-filter (signal delta)

Every stage reads the improve ledger (`improve_ledger` in `state.db`, one row per `(stash_dir, ref, source)`; `source` is `reflect`, `distill`, `consolidate`, `consolidate-pair`, `extract`, `schema-repair` or `propose`, the last written by `akm proposal new` through `createProposal`) before it spends a model call, and writes it after. It replaced the per-stage cooldown constants and the event reads behind them (`reflect_invoked`, `distill_invoked`, `consolidate_completed`, rejected-proposal rows, `proposal_fingerprints`). When a ref may be tried again is decided in one place, `nextEligibleAt`, from the row's source and outcome: a rejected or quality-rejected attempt waits 14 days (reflect), 30 days (distill) or 7 days (any other source), an expired proposal 1 day, and an attempt that left a pending proposal, needed review, judged no action or changed nothing is revisited after 7 days; an accepted or failed attempt has no window. The consolidate pair pass and a decided consolidate promotion have no clock at all: their rows hold a body hash and the ref waits until its body differs (see **Re-eligibility** above). `rejected`, `quality_rejected` and `expired` are hard windows; every other window is a revisit cadence that a newer signal (new feedback, or for consolidation an edit) lifts (`isLedgerBlocked`).

**Selection.** Before the per-asset loop, `buildSnapshotManifest` reads the feedback events once and the ledger's `reflect` and `distill` rows once for every candidate, and `partitionBySignalDelta` (both in `preparation.ts`) sorts the refs. Reflect *passes* a ref when it has negative feedback, and distill when it has feedback carrying a signal or a note (a positive one included): dated within the last 30 days, newer than that stage's last ledger attempt for the ref, with no hard window blocking it. A positive or note-only signal never plans a reflect, and neither does a negative that came with an exact fix (`akm feedback --replace/--with`, `--outdated`, `--superseded-by`) once a `feedback` proposal accepted since its event has applied the fix: it is already acted on. Then:

- A ref that passes reflect is planned for the loop. If it does not pass distill, distill is skipped for it (a `distill-skipped` action and an `improve_skipped` event with reason `distill_no_new_signal`).
- A ref that passes only distill, and is a distill candidate, is planned distill-only.
- A ref with no in-window feedback and no reflect window is left to the proactive-maintenance lane, which picks only what retrieval returned or new material (see [Retrieval scope](../improvement.md#retrieval-scope)) and plans its picks with the feedback-bearing refs. The cap against a proposal flood: `maxPerRun` (15) picks per run, an asset due only after `dueDays` (30) without a reflect or distill, and reflect's `limit` (25).
- Every ref the loop does not take is counted in the plan's `signal` gate (or its `retrieval` gate, when the proactive lane could not pick it for lack of usage evidence) and reported once, in aggregate, as an `improve_skipped` event (`no_new_signal`, `not_retrieved`).
- A memory flagged wrong is not distilled: when a negative feedback in the 30-day window recorded the hash of the body it judged (`contentHash`, the `body` hash of `content-hash.ts`) and the file's body still has it, the loop skips distill for it (a `distill-skipped` action and an `improve_skipped` event with reason `distill_flagged_wrong`) and records the attempt in the ledger as `unchanged`, so the ref waits for newer feedback. Reflect still plans it. A write that leaves the body alone (an inference stamp, a frontmatter repair) does not lift the flag; changing the body does. Feedback recorded without a hash keeps the earlier test: it flags the memory while it is newer than the file's last write, whose modification time is the edit signal, as for the retrieval scope's new material.
- A memory whose only feedback in the 30-day window is positive without a reason or note (`hasOnlyBarePositiveFeedback` in `preparation.ts`) is not distilled either: the loop skips distill for it (a `distill-skipped` action with the reason "only positive feedback, without a reason" and an `improve_skipped` event with reason `distill_positive_without_reason`) and records the attempt in the ledger as `unchanged`, so it waits for newer feedback. A bare `--positive` only records that a note helped, which gives the writer nothing to distil: 10 of the 11 lessons made from such a memory were rejected on 2026-10-05, and the 11th was good. A reason, a note or a negative signal among the feedback, or an explicit ref scope, lets it through.
- A memory whose frontmatter says `beliefState: deprecated` or `superseded` (`isDeprecatedOrSuperseded` in `preparation.ts`) is not distilled either: the loop skips distill for it (a `distill-skipped` action with the reason "marked deprecated or superseded" and an `improve_skipped` event with reason `distill_deprecated_or_superseded`) and records the attempt in the ledger as `unchanged`. An explicit `--scope` ref still runs. `contradicted` is not skipped: it marks an open conflict, not a retired note.
- The loop's refs are ranked by salience (`scoreSalience` in `preparation.ts`, which also scores the lane's picks and computes each vector with `computeSalience` from `salience.ts`): encoding, outcome, and retrieval frequency and recency, discounted for file size, with a ref that was repeatedly skipped as a no-op ranked lower. Refs missing on disk are dropped, and `--limit` cuts the list: reflect-path refs first, then distill-only refs.

An explicit ref scope bypasses every gate. Consolidation, extract and schema repair read their own ledger sources in their own stages.

## Strategy process configuration

| Process | Config path | Controls |
|---|---|---|
| `distill` | `improve.strategies.<name>.processes.distill` | Enables distillation and selects its engine/model/request overrides. |
| `consolidate` | `improve.strategies.<name>.processes.consolidate` | Enables consolidation and selects its engine/model/request overrides. |

Improve process selection is resolved once by `resolveImprovePlan`; the plan
contains every process's frozen enablement, process config, and resolved runner.
A process runs on any engine that confines the model-work tool policy; one that
cannot is refused when the plan is built, never replaced by another engine.

## Output shape

`AkmImproveResult` uses `schemaVersion: 2`, identifies the selected `strategy`,
and can report `ok: false` for terminated runs:

| Field | Type | Description |
|---|---|---|
| `scope` | `{ mode, value? }` | Resolved scope (`all`, `type`, or `ref`). |
| `dryRun` | `boolean` | Whether this was a dry run. |
| `guidance` | `string?` | Human-readable note about memory cleanup when memories are in scope. |
| `memorySummary` | `{ eligible, derived }` | Count of memory assets in scope and count of `.derived` ones. |
| `memoryCleanup` | `ImproveMemoryCleanupResult?` | Analysis (always present when eligible > 0) merged with apply results on a live run. Includes `archived`, `transitionLogPath`, `transitionLogEntries`, and `warnings`. |
| `plannedRefs` | `ImproveEligibleRef[]` | The post-filter, post-cleanup, salience-ranked refs that were (or would be) processed. |
| `actions` | `ImproveActionResult[]?` | Per-asset action records `{ ref, mode, result }`, where `mode` is an `ImproveActionMode` (`src/core/improve-types.ts`). A run emits `reflect` (a reflect proposal was queued), `reflect-skipped` (the strategy filtered the ref, or reflect declined it as `unsupported_type` or `no_change`), `reflect-guard-rejected` (a content-policy guard rejected the rewrite), `reflect-failed` (any other reflect failure, a quality rejection included), `distill` (the distill result, a validation failure included), `memory-prune` (a memory archived by cleanup), `memory-inference` (one `memories/_inference` row for the inference pass) and `error` (a loop failure other than a distill validation failure, or the wall-clock budget running out). `distill-skipped` is also emitted per ref, but `foldDistillSkipped` moves those rows into `distillSkipped` before the result is built, so none appears here. `reflect-cooldown` stays in the union for older rows and counters; nothing emits it. Absent on dry-run. |
| `distillSkipped` | `{ total, byReason, samples }?` | The folded `distill-skipped` actions: their total, a count per skip reason, and up to three sample refs per reason. Omitted when none were skipped. |
| `validationFailures` | `Array<{ ref, reason }>?` | Refs skipped due to pre-run validation failures (missing file, missing description). |
| `consolidation` | `ConsolidateResult?` | Result from `akmConsolidate`; omitted when `processed === 0` and no warnings. |
| `memoryInference` | `MemoryInferenceResult?` | Improve-owned post-consolidation memory inference telemetry. |

## Consolidation Skip Reason Taxonomy

The promote pass records a structured skip for each memory the model proposed to promote and the pass then declined to queue. They appear in `consolidation.skipReasons` of the improve result as `{ ref, skips: [{ op: "promote", reason }] }`, one entry per memory (`ConsolidateResult`, `src/core/improve-types.ts`); `emitPromotionProposal` in `src/commands/improve/consolidate.ts` is the only producer. Each skip also adds a warning line and moves the memory from `judgedNoAction` into the skip count, which keeps the accounting invariant `processed == promoted + judgedNoAction + Σ(skipReasons) + failedChunkMemories`. A skipped memory is written to the ledger as `judged_no_action` (revisited after 7 days, or at once on an edit), except a memory already promoted this run, which keeps the `proposed` row its proposal wrote, and `promote_create_failed`, which leaves no row so the next run retries it. The checks run in this order and the first that applies wins:

| Reason | Meaning |
|--------|---------|
| `promote_already_promoted_this_run` | Defensive guard: the memory was already promoted earlier in this run. `mergePlans` leaves one operation per memory, so it should not fire. |
| `promote_pending_proposal_exists` | A pending proposal already exists for the target `knowledge/<slug>`. Clears as triage drains the queue. |
| `promote_already_exists` | `knowledge/<slug>.md` already exists in the write target. Normal steady-state noise. |
| `promote_read_failed` | The memory file could not be read. |
| `promote_sanitization_failed` | The memory could not be re-serialized as an asset (an unbalanced code fence, missing or malformed frontmatter, frontmatter that is not valid YAML or not a mapping); the warning carries the reason code. |
| `promote_superseded` | The memory has `status: superseded`, which is not promotable knowledge. |
| `promote_source_too_small` | The memory's body is under 100 characters, too short to make useful knowledge. |
| `dedup_existing_knowledge` | A `knowledge/` doc in the write target already has an identical body (frontmatter aside). |
| `dedup_pending_proposal` | A pending consolidate proposal already carries an identical body. Clears as triage drains the queue. |
| `dedup_covered_by_knowledge` | A `knowledge/` doc among the 20 nearest to the memory in its bundle already holds at least half of its 5-word shingles (#998), so promoting it would queue a near-copy. |
| `promote_invalid_frontmatter` | The description it would use (the model's, else the memory's own) is missing or truncated. |
| `promote_dedup_window` | The target slug is a variant of a pending consolidate proposal's slug (dates, counters and word order folded), so it would queue a near-copy. |
| `promote_create_failed` | `createProposal` threw. The memory gets no ledger row, is retried next run, and is counted in `failedPromotions`. |

The dedup and eligibility reasons are ordinary; `promote_read_failed`, `promote_sanitization_failed`, `promote_invalid_frontmatter` and `promote_create_failed` point at a broken memory or a failing write and are worth a look when they recur. The consolidate `merge`, `delete` and `contradict` operations, and the `merge_*` and `captureMode_hot_refused` skip reasons that went with them, were removed in 0.9.17-alpha.1 (see Phase A above); the promote pass emits none of them. The pair pass (`consolidate-pair`) reports through its own result, not through `skipReasons`.

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

2. **Per-asset loop (critical accuracy bug):** The loop no longer checks validation failures. A ref that fails the pre-run validation sweep (and is not repaired) is excluded before selection (`validationFailureRefs` in `runImprovePreparationStage`, `preparation.ts`), so the first check in `runImproveLoopStage` is the wall-clock budget. The diagram's `S{ref in validationFailures?}` branch, which had also reused the `SKIP` node id of the lock-held exit, is gone.

3. **Preparation order (accuracy bug):** `runImprovePreparationStage` (`preparation.ts`) runs consolidation, session extract, memory cleanup (`applyMemoryCleanup`, `projectMemoryCleanup`, then the `memory-prune` actions and `reindexFn` when something was archived), the validation sweep and schema repair, and only then selection (signal delta, fallback lanes, salience ranking, disk check, `--limit`). The diagram follows that order.

4. **Post-loop maintenance placement (accuracy bug):** Improve now runs memory inference after consolidation, not before it (the same fix originally applied to graph extraction, retired in 0.9.17-alpha.9). The workflow now documents the maintenance stage and the reindex after inference writes.
