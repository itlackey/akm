# Meta-review shared context

Every agent spawned by `run-review.workflow.mjs` Reads this file. It holds the ground rules
and the binding decisions carried across reviews. **Keep it current:** when a review is
adjudicated, append its decisions under *Carry forward* so later reviews inherit them.

(This file is auto-injected into every review agent. Do NOT put an owner's sealed prediction
here — that must never reach an agent.)

## Ground rules (methodology)

- **READ-ONLY on live data.** Inspect `~/.local/share/akm`, `~/.config/akm/config.json`, and
  cron logs freely — but NEVER run `akm improve`/`recombine`/`extract`/`consolidate`. Open
  sqlite `mode=ro` only.
- **Verify EFFECTIVE config** (what the cron actually loads), not code defaults.
- **Prefer subtraction:** a fix that deletes machinery beats one that adds a guard/flag/wrapper.
- **No deletions.** Output *dispositions* (keep/update/merge/archive/delete); the owner approves
  any delete per-path, by name.
- **Never print secret VALUES** — reference env/secret assets by name only.
- **Metrics caveat:** improve accept/reject rows before `0.9.0-beta.50` are polluted (gated skips
  counted as rejected); discriminate with `skippedCount IS NOT NULL`.
- **Findings are local-only / gitignored** and may contain sensitive facts — never commit them.
- **Follow the constitution** - When designing, implementing, or reviewing code changes, ensure the changes comply with the coding constitution /home/founder3/akm/facts/conventions/coding-constitution.md

## Carry forward (binding decisions from completed reviews)

From **01 goal-orientation** and **05 metrics-and-evals** (adjudicated + shipped):

- akm is **BOTH pillars**: a pack-consumption channel AND a learning engine; the automation
  platform (tasks/env/secrets) is a ratified 1.0 pillar.
- Metrics are settled: **UCE** (useful context events/week) is the primary north star; **GRR**
  (per-lane 30-day external read-back rate of improve-promoted refs) is the governing number;
  minting lanes stay off below 5% GRR.
- Generation is gated on usage/feedback; proactive lanes are repointed at **ENRICHMENT**
  (metadata, graph relations), not new-content minting.
- The improve pipeline already had a **subtraction round** — PR #695 (shipped 0.9.0-beta.54)
  deleted the #691 outcome-penalty term and added event-provenance filters, two-tailed monitors,
  and an enrichment-minting rollup. **R1** (outcome weight w_o=0.15) and **R2** (salience→search
  boost) are LIVE since beta.53. Account for what's already gone; don't recommend re-deleting it.
- Security: the env comment-leak is fixed and the index rebuilt; the previously-leaked
  credentials were fake test values — no rotation needed.

From **02 bitter-lesson** (adjudicated 2026-07-03; nothing executed — dispositions only):

- **Bitter-Lesson debt map (binding framing):** the **data-side machinery LIVES** — retrieval/outcome
  salience EMAs, the `rank_score` blend and R2/utility search boosts, extract ledger/watermark,
  proposal dedup/cooldowns, drain/schema gates, and the `lesson_quality_gate` judge are the *general
  method* (usage statistics scaling with data) or harness safety, not model-compensation. Do NOT
  propose deleting them as "heuristics." The debt is the **content-judging salience heuristics**
  (13-keyword English magnitude + ref-name-bigram novelty) and the **high-salience lane** on them
  (~1.1% asset coverage, frozen at ~65 admissions/30d).
- **Approved to proceed (eval-gated, not yet executed):** (1) delete the `curate_rerank` dead
  feature key across 5 files (~−50 LOC) — gate: zero-refs grep + `bun run check`; (2) search
  contributor **ablation** (~−50 to −100 LOC) — gate: curate-golden nDCG/MRR Δ≈0 per contributor.
- **High-salience lane:** owner **pre-committed** — read-only GRR measurement authorized; **delete
  the lane if GRR < 5%** per the ratified minting-lane rule (no re-litigation). Later reviews may
  treat the lane as on-track-for-deletion pending that number.
- **Model-scored salience seam is ratified in principle:** replace the keyword/bigram encoding
  internals with model relevance scored **at distill/extract time** (zero extra LLM calls), written
  into the **same `encoding_salience` column** with `encoding_source='content'` (migration 015 seam
  — **no schema migration**), copying the `lesson_quality_gate` fail-open/timeout template. Deferred
  behind the lane-GRR gate so the swap isn't judged through a frozen lane.
- **Recombine no-embeddings constraint:** commissioned a **60-day entity-led vs embedding-led**
  accept-rate/GRR trial before any change; constraint is neither ratified nor deleted.
- **Docs:** `v1-architecture-spec.md` drift (scorer key never existed, DB_VERSION 9-vs-17, 7-vs-11
  feature keys, missing recombine, §14.6 consolidation contradiction) is **routed to review 14**.

From **03 memory-compounding** (adjudicated 2026-07-03; nothing executed — eval-gated dispositions only):

- **Governing number:** the owned stash is **98.2% write-only** (1.77% lifetime touch rate; 302/17,072 entries ever touched by any usage event). Verdict = **ACCUMULATING, not compounding** — re-adjudicate only when `improve_cycle_metrics` has **≥30 days of rows** (currently 2, same day). ~92% of state.db (4.63GB) is `improve_runs.result_json` telemetry, not knowledge.
- **Binding framing (for 04/06):** the **tool-dispatch pattern** (script/command/agent/skill/workflow — explicit, human-gated, dispatch-consumed) is the compounding **existence proof** at 40–73% reuse; auto-minted content types are 0.1–1% touched. Push content minting *toward* that pattern (read-back-gated, task-anchored, like `propose`) — **never widen auto-mint (extract's enum, remember) into the healthy dispatched types.** The capture asymmetry is a KEEP, not a gap.
- **Approved now (eval-gated):** (1) delete the two `type === "memory"` belief guards (`ranking-contributors.ts:109`, `db-search.ts:560`, net −2 lines) so `contradicted`/`superseded` penalties apply to all **2,441** flagged knowledge entries — gate: curate-golden nDCG/MRR Δ; (2) one-**directed**-edge contradiction fix (`memory-contradiction-detect.ts:314-318` currently writes mutual A↔B edges → SCC resolver erases every detected contradiction each run) — gate: edges persist across a read-only re-run. Full **bi-temporal R7 stays deferred** behind these.
- **Ratified retention/decay/promotion rules (4 subtract, 1 add):** R-1 stop `session_checkpoint` memory writes + delete downstream exclusion filters (`recombine.ts:233-258` + siblings) — the "later-extract" pointer, if wanted, goes in the **extract ledger**, not a memory asset; R-2 bulk `<path>-lesson` lane off below **5% GRR** (existing ratified rule; lane read-back 0.48%); R-3 supersede base on `.derived` write + **delete the `derivedBoost` constant** (`ranking-contributors.ts:153-162`; 1,248 twin pairs); R-4 stop persisting `content_hash` on `llm_unavailable`/`triaged_out` (existing null-hash retry unlocks 158 locked sessions); **R-5 (the only addition)** promotion memory→knowledge requires **≥2 external read-backs/30d** (reuses GRR/`usage_events`, no new tables).
- **opencode-sdk `sessionLogs=false` = a BUG** (SDK subagent sessions invisible to extract) — fix the reader; also removes any need for an R-1 memory pointer.
- **Outcome-EMA hygiene:** one-time backfill of **42** pre-#695 poisoned `asset_outcome` aggregates (load-test bursts + `tool_failure`/`slice:train` auto-signals now feed live ranking at w_o=0.15) — approved, no schema change, after confirming #695's provenance filters exclude those sources forward.
- **Docs:** `storage-locations.md` DB_VERSION=14 vs live 17 → **routed to review 14** with the 02 v1-spec DB_VERSION drift (same doc-sync batch).

From **04 stash-self-model** (adjudicated 2026-07-03; nothing executed — dispositions approved, proposal emission is an authorized follow-up):

- **Acceptance-test verdict for `improve-bitemporal-invalidation-design.md`:** the drift-prevention
  mechanism **exists and SELF-ERASES.** Contradiction detection runs unconditionally dozens of times/day
  via cron, then the **mutual A↔B edge** write (`memory-contradiction-detect.ts:314-318`) → SCC treats the
  2-cycle as a **sink** and refreshes both to active/asserted (`memory-improve.ts:392-545`) →
  `persistBeliefStateTransition` deletes the `contradictedBy` frontmatter (`memory-improve.ts:647-668`),
  all in the same run. The 169 `contradicted` base memories are lucky residue; LLM judge calls are
  re-burned on the same pairs daily. The **03-ratified one-directed-edge change is confirmed as THE
  mechanism fix** (gate: edges persist across a read-only re-run). **R7 stays deferred.**
- **staleness-detect pass (`src/indexer/passes/staleness-detect.ts`): OWNER KEPT IT OPEN** — NOT routed to
  review 06 as a deletion candidate, NOT to be enabled as the drift fix. Facts for whoever revisits it:
  feature-gated off, no `index`/`staleness` config key, exactly 1 `lastConfirmedAt` in the whole stash,
  90-day default threshold mis-fit for a ~53-day-old stash whose drift onset was 33 days. Enable-vs-delete
  stays an open question; do not treat as on-track-for-deletion.
- **Structural leak (root-caused):** archiving a base memory **strands its `.derived` twin live forever**
  (68% of memory rows are twins; 0 of 169 contradicted bases' twins carry `beliefState`; a contradicted
  base nets −0.53 while its flag-free twin nets +0.12, so the stale copy **outranks** the corrected one).
  Root fix = 03's ratified **R-3** (supersede base on `.derived` write + delete `derivedBoost`,
  `ranking-contributors.ts:153-162`) plus the two `type === "memory"` guard deletions.
- **Approved dispositions (archive-not-delete, via proposal queue; first-ever memory-type batch through
  the queue):** B1 archive 2 orphan twins; B2 archive ~300 `session_checkpoint` memories + ~18
  session-lessons (chunked ≤50, ~7 passes; source fix = R-1); B3 invalidate 3 stale version memories + the
  14-key `version-sync` cluster → 1 corrected knowledge entry (live truth: **0.9.0-beta.54**, no
  `release/0.8.0` branch, openpalm pins `^0.8.0` semver in `containers/`, not `core/`); B4 merge 4 PR #682
  "branch still open" memories → 1 (PR **MERGED 2026-07-02**); B5 merge 5 "contradiction detect is
  config-gated" memories → 1 (**no gate exists** — even the docstring at `memory-contradiction-detect.ts:26`
  lies; delete the claim, don't add the gate). B6 re-verify `openpalm-auth-evolution-roadmap` only.
- **B7 `.meta/index.md` fill APPROVED** — the one sanctioned ADDITION (~10 lines: stashDir purpose, the
  tool-dispatch-compounds/content-accumulates split, the proposal-queue rule). Placeholder scaffold since
  2026-06-22; `akm show meta` returns it verbatim over 24k entries.
- **Recall-quality note:** every flagged asset has **0 `usage_events`** (28k total) — the batch buys
  **worst-case-wrongness elimination** (version/branch/pin queries stop returning ranked falsehoods) and
  contradiction-judge-load relief, **not measurable nDCG gain**; gate code changes on **curate-golden
  Δ≈0-or-better**, not improvement.
- **KEEP bar (articulated):** freshness + verifiability (dates/numbers) + active-project relevance — do NOT
  batch-archive unverified project-state memories on suspicion (the over-correction ditch).

From **06 autonomy-ladder** (adjudicated 2026-07-03; nothing executed — dispositions only):

- **The ladder has ONE operating rung.** Proposal resolution is **100% automated** (0 of 20,726 accepted
  rows owner-annotated; 93% resolve <24h; every sampled promotion `autoAccept:true`). The docs' "owner-gated
  queue" is **fiction** — relabel it **audited-autonomous (AA)**. Per-item approval (PI) exists and works ONLY
  at `/akm-memory-promote` + `/akm-proposal accept`; do NOT demote high-volume autonomous actions to PI (that
  is the gate-costs-more-than-it-protects trap).
- **Two highest-blast-radius writes run BELOW every improve gate — both approved for removal:** (M1) the
  Claude-hook `session_checkpoint` **direct stash write** (`akm-hook.ts:1371-1451`, `remember --force`, no
  judge/confidence/schema gate) → **execute 03's ratified R-1** in the next execution batch (delete the
  `captureMemory` shell-out + the `recombine.ts:233-258` exclusion filters); (M2) the nightly `akm update --all`
  cron (`update-stashes.yml`, 14 third-party sources into the tool-dispatch tier) → **DELETE the cron**, pull
  on demand. NOTE the split: memory-*candidate* capture (regex sidecar → `/akm-memory-promote`) is the **KEEP
  reference rung**, NOT M1's `--force` write — do not conflate them.
- **Approved subtractions (eval-free, mechanical):** (M4) archive-on-validation-throw in the
  `improve-auto-accept.ts:292-312` catch (all 7 pending items are unreachable zombies; 90-day TTL fired 0× in
  2,754 passes); (M5) delete the `proactiveMaintenance:{enabled:true}` block from builtin
  `src/assets/profiles/default.json` (it silently overrides code-default false in the nightly default lane —
  the "verify effective config" trap; the weekly YAML's "disabled-by-default" claim is false); (M7) delete the
  dead `autoAccept` param/threading (`recombine.ts:131`, `loop-stages.ts:798`; drain tier never calls
  `runAutoAcceptGate`) + add `maxDiffLines` to the uncapped `PERSONAL_STASH.accept` extract rule.
- **Ratified KEEPs (defended; binding on later reviews):** consolidate **95-floor** merges (AA — 9,612 accepts,
  zero loss incidents); salience/`rank_score` **UPSERTs (A — refuse future gates**, derived/recomputable, gating
  them stops the usage-statistics learning loop); watermark/extract-ledger + index (A); memory-candidate
  capture→promote (**PI, the reference rung**).
- **Deferred:** (M6) the daily `curate-to-wiki` minting lane (`curate-agent-learning.yml`) has **no GRR number**
  and escaped scrutiny by living outside `akm improve` — GRR measurement **NOT yet authorized**; standing
  <5%-GRR deletion rule not yet armed for this lane.
- **Docs → review 14 batch:** `improve-workflow.md` narrates a human-in-the-loop review that the DB proves never
  happens (0 owner annotations); also add the M7 sentence that the drain tier is deterministic-policy-gated, not
  confidence-gated. Route with the 02/03 doc-sync items (DB_VERSION drift, v1-spec, storage-locations).

From **07 prompt-injection** (adjudicated 2026-07-03; nothing executed — approvals authorize the execution batch):

- **Repo scope is now BOTH repos, and ALL akm-plugins work is APPROVED (owner 2026-07-04).** This series'
  execution batch **covers akm-plugins**, not only akm, and every akm-plugins item review 07 surfaced is approved
  for execution (no per-item confirmation pending): the `captureMemory` shell-out subtraction + SessionStart
  re-injection provenance-tagging, the `/akm-agent`·`/akm-cmd` **dispatch-side** toolPolicy ceiling, and the
  SubagentStart hook side. The akm side (`renderers.ts`, `docs`, `quality-gate`, `extract-prompt`, workflow-run
  emission) lands here. Later reviews may assume akm-plugins is in-scope.
- **The captureMemory chain is CROSS-REPO + already ratified.** `akm-hook.ts` / `akm-agent.md` / `akm-cmd.md` /
  `akm-curator.md` do **not** exist in the akm repo (verified). The verbatim SessionEnd→`remember --force`→
  SessionStart re-injection chain is **03-R1 / 06-M1**, not a new finding — do not re-headline it. Its akm-side
  support is deleting the `recombine.ts:233–258` exclusion filters once the memory writes stop.
- **Approved Phase-0 (in-repo, eval-free, subtractive):** (1) delete the FALSE `docs/registry.md:201–204`
  "install scans for prompt-injection phrases" paragraph — **no such scanner exists** (grep: zero source-body
  scans; the only real audit is `add-cli.ts:65–215` env **key-name** allowlist + path-traversal) → replace with
  the truth, do NOT build the advertised scanner; (2) `quality-gate.ts:155,172` **fail-CLOSED** on
  parse-failure/timeout for minted content (currently `pass:true` — verified the gate IS enabled in effective
  config, no profile overrides `distill.qualityGate`; note the 2.5–3.5 `reviewNeeded` band already returns
  `pass:false`, so the fail-open is ONLY parse/timeout/no-LLM); (3) fence the extract transcript with the
  **existing** `=== ASSET N ===` marker (`graph-extract.ts:38`), reused in `extract-prompt.ts`.
- **Approved Phase-1 (in-repo, structural):** (B) **stop emitting raw workflow-run titles/params into subagent
  context** — emit only run IDs/status (`src/workflows/runtime/runs.ts` copies `workflowTitle: asset.title` from
  frontmatter into EVERY SubagentStart payload, unfenced — proven live). (D akm-side) provenance-aware
  **toolPolicy CEILING** at the show layer (`renderers.ts:262–263` hands over an asset's self-declared `tools`);
  reuse the `env-cli.ts:316–324` `registryId` provenance test so a third-party asset cannot widen the grant. NB:
  `toolPolicy` is a **ceiling-capped request, not a self-grant** — a subagent cannot exceed the parent's grant;
  the real residual is default-inheritance with no provenance ceiling. The **dispatch-side** ceiling
  (`/akm-agent`,`/akm-cmd`) is akm-plugins and is **APPROVED** (owner 2026-07-04 blanket-approved all akm-plugins
  work; the earlier akm-side-only scoping is lifted).
- **KEEPs (binding, defend):** the **tool-less HTTP runner** (`chatCompletion`, no tools/filesystem — used by
  extract/graph-extract/judge; injection corrupts output text only, cannot execute); the **env-key-name audit +
  third-party `registryId` refusal** (`add-cli.ts`,`env-cli.ts` — precise, provenance-aware, fails closed). Chain
  G (reflect *can* resolve a tool-capable runner in unattended improve) is **LATENT** — effective config not
  shown to trigger it; carried as P1.3 hardening (pin unattended-improve reflect to the tool-less runner), not a
  gated KILL.
- **DON'T-ADD (binding):** do not build the advertised prompt-injection phrase-scanner; do not thread a new
  origin-trust column through recall/curate/show (`quality` already conflates editorial-state with origin — a
  trust field everywhere is net-additive machinery that still leaves the mint paths open). The leverage is
  **removing** untrusted→trusted mint paths, not tagging around them.
- **Sealed-prediction outcome:** PARTIAL MATCH — owner named the registry-kit surface correctly, but the feared
  "poisoned agent self-grants privilege" is overstated (ceiling-capped request); the sharper in-repo edges are
  the workflow-title channel (B) and the fail-open gate (C).

From **08 attack-surface** (adjudicated 2026-07-04; nothing executed — dispositions binding):

- **The single worst surface is the OUTER boundary, not the inner walls.** akm's value-redaction architecture
  (leak-free renderers with no content field, key-name-only `listKeys`, child-only env injection, `redactErrorBody`,
  `sanitizeConfigForWrite`, tool-less HTTP runner, zero remote telemetry) is **excellent and every piece is a KEEP** —
  do NOT propose replacing any with generic scanning/encryption machinery (reaffirms 07's DON'T-ADD). The gap is that
  these walls sit INSIDE an unguarded directory.
- **F1 git-tracking of `env/`+`secrets/` — REFRAMED by owner, NOT a purge.** `~/akm` is a git repo tracking 16
  env/secret files incl a signing key + bot creds (verified live), saved only by no remote. Owner ruling:
  **versioning env/secrets is an intentional, supported use case** (private-remote backup). The bug is they're
  tracked BY DEFAULT. Fix = akm must **scaffold a default `.gitignore` ignoring `env/`+`secrets/`** at init/setup
  (the v0.8.0 vaults→env/+secrets/ migration never migrated the ignore rules — `.gitignore` still covers only dead
  `vaults/*`; init/setup scaffold none). User **opts in by un-ignoring**. **On this host: KEEP tracked as-is — no
  `git rm --cached`, no `filter-repo`** (deliberate opt-in). Health advisory `stash-git-exposure` APPROVED but
  **re-tuned: warn only when tracked AND a remote is configured**, not merely tracked (catch the leak moment, don't
  nag the opt-in). This is a **default-safe-scaffold**, the inverse of the finding's delete framing.
- **F2 APPROVED (the one justified addition):** add `env`/`secret` to a **structural type refusal** at the
  distill/reflect raw-`readFileSync` sites (`distill.ts:718-728`, `reflect.ts:391,1034`; mirror the existing
  `DISTILL_REFUSED_INPUT_TYPES={'lesson'}`, ~2 lines) so the floor is **code, not config**. Today only `allowedTypes`
  config stands between secret bytes and the LLM endpoint in unattended cron (live proof: `improve_skipped` fired
  516×/453× for env/secret refs, `profile_filtered_all_passes`; 0 distill/reflect invocations ever).
- **Approved subtractions:** (F3) uninstall stale `akm-cli@0.7.4` + **delete the `~/.local/bin/akm` wrapper's
  npm/usr-local fallback branches** so it errors loudly instead of degrading against the shared config/DBs (proven
  incident class: PR #676 skew, 2026-05-23 config clobber); (F4) `chmod 600/700` the downgraded env/secret/backup/DB
  set + `gio trash` the **two ORPHANED `config-backups/` dirs** (`$DATA`,`$CONFIG` — legacy write locations, no longer
  pruned; the 5-cap prune only ever governed `$CACHE/config-backups`, which dissolves the docs "5 vs forever"
  contradiction) + 15 ad hoc `.bak-*`; write env/secret/backup files `0600` akm-side (extend the `env-cli.ts:180-197`
  pattern, don't invent one).
- **F5 KEEP narrow — REFUSE per-stash config layering** (net-additive machinery for a subcase with no live occurrence;
  the 2026-05-23 tmp-sandbox trigger is already closed by `paths.ts` redirect + `assertSetupSandbox`).
- **F6 carry-forward:** the raw workflow-title injection fix is **owned by 07 Phase-1 B** (do not re-headline). NEW
  hygiene disposition: **expire/complete the 8 stale 2026-05-12 "Test Flow" runs** (still `active` 54 days later,
  injected verbatim into every subagent) via workflow commands; consider a staleness WHERE-clause on the `--active`
  query (not machinery).
- **DON'T-ADD (binding):** no encryption-at-rest for env/secret (threat model is git-push + `$HOME` traversal, both
  solved by the ignore boundary + perms); no redaction scanner; no per-stash config layering; **no standalone
  AttackSurface skill or AssessAttackSurface flow** — the deliverable **folds into `akm health`** (a read-only
  `surfaces` advisory group: `stash-git-exposure`, `secret-file-perms`, binary-vs-configVersion skew, orphan-store
  detection, egress list) and **re-running review 08** is the re-audit. The living inventory doc IS
  `findings/08-attack-surface.md` (Part 1 table row-key = surface name, diffable run-to-run).
- **Docs → review 14 batch:** F7 undocumented 285MB `~/.local/state/akm-claude` tier (no retention) + `logs.db`
  missing from `storage-locations.md` index + events-table schema drift + backup-location truth (one live, two dead) +
  `storage-locations.md:371`/`data-and-telemetry.md:51` perms corrections. Add `state.db.bak-20260614` (2.6GB) to the
  standing post-GA `result_json` prune list.
- **Sealed-prediction outcome:** PARTIAL MATCH — owner nailed Q1 (env/secret assets hurt most = confirmed single worst
  surface) but Q2 diverged (predicted shared `config.json` least-protected; actual weakest link is the **same
  env/secret store** from the git-boundary angle, which the owner didn't model — config-sharing is real but only
  HIGH/MED at F3/F5). Hurts-most and least-protected turned out to be the same files, two sides.

From **09 steelman-the-bets** (adjudicated 2026-07-04; E0 authorized for immediate execution, rest dispositions/gated):

- **Bet ranking (binding framing):** rank-1 = **improve pipeline is net-positive** — verdict **DECIDABLE AND
  UNDECIDED**, not confirmed-failing. The two clubs the gather phase reached for (lifetime GRR 0.6% AND the
  2026-07-01 verdict's corpus delta −0.216) **both come from ONE weak 13-ref instrument** whose own `downstreamLift`
  shows treatment refs read back **~19× control** — the same instrument cannot prove "read-back is dead" AND "corpus
  regressed." Do NOT cite either number as settled in later reviews. Noticeability = **BLIND at value level** (health
  measures process only; `plannedCount`/`acceptedCount`/`skippedCount` grep-zero in `src/commands/health/`).
- **E0 — PREMISE CORRECTED by a read-only census this session (receipt: `findings/09-grr-receipt.sql.md`).** The review
  said lane-GRR was uncomputable (`eligibilitySource` on only 4,864/15,071 proposals). **Disproved:** the ~10,016 without
  it are **entirely `consolidate`+`extract`, both already lane-attributed by `proposals.source`**; `eligibilitySource`
  only sub-divides the reflect lane (96% populated there). **Universal lane key = `COALESCE(eligibilitySource, source)`
  — NO write-site plumbing needed; threading the field through consolidate/extract is redundant machinery (do not build
  it).** The two REAL blockers the review mislabeled: (1) the naive `usage_events.entry_ref LIKE '%//'||proposals.ref`
  join is un-indexable and hangs — own-stash proposals are bare `type:name`, `entry_ref` is origin-qualified
  `source//type:name`; fix = normalize `entry_ref` to bare ref FIRST then equi-join (the relink perf pattern), runs in
  seconds; (2) the actual enabling fix is **review 05's G5 provenance tagging** (`usage_events.source` 30d is
  `user|14806, task|10` ≈ 99.9% `'user'`, conflating real reads with plugin/hook/cron self-reads) — so all GRR below is
  an **UPPER BOUND**. The canonical query is committed as the receipt. **E1 was runnable today** (contra the review) —
  numbers below.
- **G5 RESIDUAL ROOT-CAUSED + FIXED 2026-07-04** (branch `fix/grr-provenance-passthrough-and-verdict-fallback`, commit
  `8119a456`; gate green: unit 5332/0, agent+env integration 9/0, lint/tsc clean). The `:00`/`:30` `'user'` read spikes =
  the `discord-wiki-articles-ingest` cron (`*/30`) → `akm wiki ingest articles` spawns an opencode agent whose own
  `akm curate/show/search` tool-calls logged `source='user'`. Root cause: `buildChildEnv` (`spawn.ts`) filters
  `process.env` through the `profile.envPassthrough` WHITELIST, and `AKM_EVENT_SOURCE` was NOT in `COMMON_PASSTHROUGH`
  (`profiles.ts`) → the task-runner's `AKM_EVENT_SOURCE=task` stamp was dropped at every NESTED agent boundary (runner.ts:454
  `options.env` only covers agents the runner spawns DIRECTLY). Fix = add `AKM_EVENT_SOURCE` to `COMMON_PASSTHROUGH` (one
  entry) — NOT a new enum, NOT excluding the SessionStart plugin curate (genuine demand, spread, correctly stays `'user'`).
  Also fixed `proactive-verdict.ts` `usedFallback` (scoped to reflect-source rows so consolidate/extract stop spuriously
  forcing pilot-file-fallback). **Once shipped + cron re-runs, the minting-lane GRR will drop even lower** (self-reads
  removed) — re-run the receipt query to confirm. Still on-branch, not merged/released.
- **LIVE per-lane GRR (2026-07-04, mode=ro, UPPER BOUND — G5 not yet applied; can only go DOWN):**
  extract **0/2,778 = 0.0%** → **DEAD, triggers the pre-approved E2** (cron 48×/day → 1× nightly + drain routing);
  proactive **102/4,331 = 2.4%** → **FAILS the 5% minting floor at n=4,331** (corroborates the proactive-weekly FAIL
  verdict with a far stronger instrument than its 13-ref cohort, independent of the weak −0.216 delta); consolidate
  0.0% (HYGIENE — not GRR-gated, expected); enrichment/usage-triggered lanes healthy **by construction** (not evidence
  of minting value): high-retrieval 44.9%, reflect 24.0%, signal-delta 15.6%; **INCONCLUSIVE (n<30 per review 05's
  rule):** high-salience n=14 (57.1% — **02's delete-if-GRR<5% gate is NOT yet armed**, too few refs), recombine n=16
  (6.3%), distill n=1. **Bet 1 verdict rendered in live numbers: SPLIT exactly as 01/03 bound — the MINTING half fails
  the read-back floor, the ENRICHMENT half is healthy because usage is its trigger. Repoint minting→enrichment; keep
  minting gated. Not uniformly wrong.**
- **Bet 3 is NEW and load-bearing: "auto-accept is safe."** The whole audited-autonomous model (06: one rung, 100%
  auto-resolve, **0/20,726 accepts ever human-labeled**) rests on the judge/quality-gate catching bad content with no
  human backstop — never named or measured. **E3 APPROVED, BUNDLED with 07's fail-CLOSED change** (`quality-gate.ts:155,172`):
  owner labels ~50 random auto-accepts (first-ever gate-precision anchor; seeds 03 R-5) **and** the fail-CLOSED fix ships
  as one unit. Observed failure class so far is *worthless* not *destructive* content (consolidate 95-floor: 9,612 accepts,
  0 loss incidents) — do NOT demote high-volume lanes to per-item approval (06 binding).
- **Bet 4 is NEW: single-corpus generalization.** Every tuned threshold (5% GRR floor, salience weights, cooldowns,
  curate-golden) derives from the owner's stash ALONE; zero transfer evidence, and 08's zero-telemetry boundary makes it
  **structurally invisible forever.** Owner elected **E6 (second-corpus probe)** — a disjoint-domain stash or one recruited
  beta user — over carrying it blind. This is the series' most structurally-invisible bet.
- **Proactive-weekly FAIL verdict — DECIDE AT BATCH AFTER E0** (disable per 06-M5 vs overrule in writing); lane stays
  `enabled:true` in the interim by explicit choice. The verdict is too weak to act on until E0 fixes the 13-ref cohort so
  the next monthly verdict bears weight. "Ignored for 3 days" was manufactured urgency (weekly task, no run skipped).
- **Bet 5 (substrate) reframed:** the SQLite-vs-long-context frame is **near-strawman** (ignores unbounded corpus growth,
  the secrets-on-disk privacy boundary, and the automation-platform pillar). The real unproven complexity is **hybrid stack
  (embeddings + graph + rank-blend) vs plain FTS5** — settled by **02's already-approved contributor ablation** (run it
  before any substrate re-litigation), NOT by E5's blind-compare (which tests only today's 302-entry working set, falsifies
  nothing about scale/privacy/year-3 cost).
- **Bet 6 (salience) — nothing new;** already conceded+gated by 02. Residual: execute the 02 lane-GRR pre-commitment when
  the number lands; leave stored salience unwired (cheaper than fixing); **doc demotion → review 14** (stop presenting
  recombine/salience as neuroscience-grounded — the project's own survey grades recombine's confirmation gate "Loose, no
  biological analogue").
- **The ONE approved consumption-side addition:** extend the EXISTING monthly verdict script to emit per-lane 30d GRR
  alongside its retrieval-quality delta (it already joins treatment refs to eval outcomes). **DON'T-ADD (binding):** no new
  health checks reading `metrics_json`, no GRR dashboard, no alert layer. The 03 rule stands: re-adjudicate the compounding
  verdict only at **≥30 days** of `improve_cycle_metrics` (7 rows / 2 days now).
- **Docs → review 14 batch (append):** neuroscience-framing demotion of `improve-neuroscience-alignment-survey.md` +
  `improve-vs-brain-analysis.md` (justification→inspiration). **Distribution hygiene → 08/14 batch:** repoint npm `latest`
  (=0.8.14 vs working beta.56) or publish stable; deprecate the older sibling plugin repo; record that npm/GitHub are the
  ONLY adoption instruments (chosen invisibility, owned in writing).

From **10 what-10×s-what-dies** (adjudicated 2026-07-04; strategy artifact — no code changed, dispositions only):

- **Two obsolescence axes are binding for later reviews, not one.** Every DIES test must be scored on BOTH the
  **M-axis** (model trajectory: long context / native retrieval / cheap inference / better tool use) AND the
  **P-axis** (platform trajectory: Claude Code / OpenCode shipping native skills, subagents, plugins, MCP, project
  memory). The most-exposed subsystem is the **tool-dispatch tier** on the P-axis — it lives inside the harnesses'
  extension points, so the harness is simultaneously akm's distribution channel and its principal competitor. The
  defensible property is **harness portability** (the bench survives switching harnesses), NOT dispatch-the-mechanism
  → keep the CLI the source of truth and plugins THIN adapters (binding hedge).
- **The store is regenerable exhaust, not the moat.** Live quality distribution (sqlite ro, 2026-07-04):
  enriched=19,493, generated=5,174, **curated=9 → 0.036% human-curated**; 98.2% write-only. The moat is
  **taste + trust + the audit trail**. Stop measuring value in entry counts. Exhibit that proves it:
  `knowledge:akm-hybrid-rendering-architecture` is a misfiled static-site-generator doc that the review prompt's own
  ref list mistook for an akm subsystem.
- **Consumption/context-assembly is DURABLE, not dying** (settles the sealed-prediction divergence): the owned corpus
  (24,676 entries / 684 MB) exceeds any 128K–1M window on the 2-year horizon, so selective retrieval/packing survives
  BECAUSE the store is too big for the window. What dies is the *compression* machinery that assumes scarce context —
  consolidation-future-vision's chunk-orchestration ("dies before built"), pre-filter's 32K-era truncation, encoding
  salience's keyword compression.
- **Q1 (freeze scope) — OWNER DECLINED THE 1.0 FREEZE for now.** Do NOT narrow/mark-EXPERIMENTAL the v1 spec surface
  yet: "a 1.0 contract is premature for a product of one; keep everything unfrozen, revisit after distribution exists."
  The §5 four-contract frozen surface (consumption / dispatch+toolPolicy / env-secret / provenance) is the *shape to
  freeze WHEN a freeze happens*, not an authorized edit. The E6 second-corpus probe (09 Bet-4) is the prerequisite
  before any freeze is reconsidered. Later reviews: do not treat the 1.0 contract as settled.
- **Q2 (proactive lane) — DEFER TO POST-E0** (consistent with 09): decide disable-per-06-M5 vs overrule at the batch
  after E0/G5 ship and the number is final. Lane stays `enabled:true` in the interim by explicit choice.
- **Q3 (staleness-detect) — DELETE; keep only the more reliable audit path (matches the analysis).** (An initial
  "enable" answer was an owner misread, corrected same session.) Binding: do NOT run two overlapping audit mechanisms.
  Keep only the **usage-event/GRR loop** (row 9) — model- AND platform-durable, actually populated — and **retire
  staleness-detect** + the belief-currency mechanism as theater (1 `lastConfirmedAt` in the whole stash, self-erasing
  contradiction edges). Resolves the row-10 tension in favor of a single audit trail. Do not re-propose reviving
  belief-lifecycle currency on a 2-year horizon.
- **Q4 (positioning) — ADOPTED (binding positioning sentence):** "akm is FOR the owner's *taste made durable*: a
  portable, provenance-audited bench of his own tested tools and curated knowledge — with a provable read-back trail
  of what earned its place — that outlives whichever model or agent harness he runs this year." Supersedes the
  secrets+dispatch+trail draft triad. env/secret is a **1.0 contract, not a headline pillar** (commodity locally:
  direnv/sops/doppler/1Password-CLI).
- **Q5 (extract) — DOWNGRADE CONFIRMED:** freeze `pre-filter.ts` (zero retuning of `DEFAULT_MAX_TOTAL_CHARS`/truncation
  for 131K models), execute pre-approved **E2** (48×/day → nightly), **fix the 03-ratified `opencode-sdk
  sessionLogs=false` input bug**, then re-measure. The ratified <5% minting-lane rule executes itself at the
  re-measure. Do NOT delete extract on today's 0.0% — GRR is blind to its feeder role and its input pipe was starved.
- **NOT-BUILD (binding, adds to prior DON'T-ADD lists):** consolidation-future-vision's graph-cluster + chunk-orchestration
  layer (one prompt at 131K+); R7 bi-temporal validity lifecycle; pre-filter retuning for long-context; any GRR
  dashboard/alert/new `metrics_json` health check (re-affirms 09); a **facts minting lane** (grow `fact` type via
  curation — the B7 `.meta/index.md` fill + `/akm-memory-promote` PI rung — NOT minting); registry trust machinery for
  an ecosystem of one. **chunking.ts "subtract the token formula" claim was CUT after code verification** (it already
  reads configured `contextLength`; 4096 is a legitimate agent-CLI overhead fallback) — do not resurrect it.
- **Sealed-prediction outcome:** DIVERGE. Owner predicted prompt/context assembly dies first ("just dump it all in");
  analysis flips *packing* to a frozen-contract (corpus > any window) while agreeing the *compression* sub-parts die.
  Real first casualty relocated to the minting lanes + the platform-absorbed dispatch layer.

From **11 decisions-into-policy** (adjudicated 2026-07-04; nothing executed — dispositions only):

- **Binding thesis:** every decision akm *mechanized* (isolation lint + shrink-only ratchet, CI release `needs:`
  gate, code-encoded runtime thresholds) stopped recurring the day it landed; every decision left as *prose*
  (CLAUDE.md rules, stash memories) kept recurring — including the only two with REALIZED irreversible costs
  (2026-05-22 `rm -rf` on NVMe+TRIM; 2× unrequested `akm improve recombine` on live data). Current enforcement =
  ZERO (`~/.claude/settings.json` hooks `{"Notification":[],"Stop":[]}`, no PreToolUse). The estate's ONE fully
  mechanized subtraction principle is the test-isolation lint (`scripts/lint-tests-isolation.ts` + strict-equality
  ratchet `ALLOWLIST_RATCHET_BASELINE=64`) — the before/after proof that enforcement beats memory.
- **§3.1 PreToolUse gate — APPROVED, ASK-MODE (not deny).** ONE hook in `~/.claude/settings.json` covering (a)
  destructive `rm`/`rm -rf`/`rmdir`/`git clean -fd`/`find … -delete` outside the CLAUDE.md always-safe list, and (b)
  unrequested `akm improve|recombine|extract|consolidate` + `akm proposal accept` in dev sessions. **WIDENED (owner):**
  also guard writes to the live `~/.config/akm/config.json` / `stashDir` from a non-sandboxed session (closes the
  HOME/XDG-config-repoint incident `akm-isolate-config-in-init-repros`, cron improve killed exit 78). Semantics =
  **ask-for-confirmation**, preserving an escape hatch for genuine per-path deletes / authorized runs. This is the
  series' one authorized addition (quadrant A: expensive+irreversible+failed-twice-as-prose). CLAUDE.md prose STAYS;
  the hook only makes its floor mechanical. Supersedes ~3 documenting artifacts → merge/archive via proposal queue.
- **Install-version-unification NOT added as a new worklist item** — stays where **08-F3** routed it (uninstall stale
  `akm-cli@0.7.4` + delete the `~/.local/bin/akm` wrapper npm/usr-local fallback branches). Divergence recorded, scope
  not expanded.
- **§3.3 WS-4 auto-tune/exploration path — OWNER KEPT OPEN (declined deletion).** Despite 0 `improve_gate_thresholds`
  rows ever / `autoTune` off / effective `improve={}` / unreachable, owner keeps it (possible 09-E3 revival). Treat as
  **owner-kept-open, NOT on-track-for-deletion** (mirrors 04 staleness-detect). The DON'T-ADD "no rebuilding WS-4
  properly" still stands — keeping dead code ≠ authorizing a rebuild.
- **§3.2 06-M5 execution — HELD (still ratified-but-unexecuted).** Do NOT delete the `proactiveMaintenance:{enabled:true}`
  block from `src/assets/profiles/default.json:14` (verified still present this session) or add the
  builtin-vs-`IMPROVE_PROCESS_DEFAULTS` pinning test this batch. The effective-config trap stays re-armed by explicit
  choice; contradicting `docs/design/improve-optimal-default-config.md` still routes to the **review-14** doc-sync batch.
- **Meta-rule (new capture policy, prose-only by nature):** a memory→lesson promotion must attach an enforcing artifact
  (test/lint/code-seam/hook) OR declare itself documentation-only; code-mechanic memories must cite a **greppable symbol
  name, not a line number** (the gather phase burned effort on 2 ghost memory refs + 1 moved gate; the salience
  working-reference lesson still teaches the #644 bug the code FIXED via `isContentEncodingRow`).
- **Defended KEEPs (binding):** release-gate memory (SPLIT — gate already lives in CI via `release.yml` `needs:`,
  taxonomy of ~17-22 host-state flakes correctly lives in memory; prompt's "move to CI" premise was half-wrong);
  decentralized 6-YAML + advisory-lock lane shape (REFUSE a central scheduler); documented-only check-before-push
  (REFUSE a pre-push hook — CI catches it); code-encoded runtime thresholds (signal-delta, 95-floor, `salienceThreshold`
  0.75, `archiveRetentionDays` 90, extract 48h floor — settled policy, do not re-litigate as tunable heuristics).
- **Sealed-prediction outcome:** PARTIAL MATCH — owner nailed the enforcement half exactly ("only documented"), diverged
  on the named decision (owner: felt friction of repro-sandboxing + unified installs; analysis: realized irreversible
  cost of delete + prod-mutation). Intersection = sandbox-during-repro = row 1's prod-mutation family, which drove the
  hook-widening decision above.

From **12 one-real-constraint** (adjudicated 2026-07-04; nothing executed — dispositions only):

- **THE binding constraint (binding framing for later reviews):** demand-side **read-back at the resurface→session
  link, for self-generated content only.** ~14,937 promotions/30d → **77 engaged self-generated refs (~194:1
  mint-to-engagement)**, vs pack **311** / hand-authored **149** from far smaller corpora. Every other stage measures
  CLEAR: throughput (17 pending lifetime, queue empty), capture (over-provisioned — 79.7% `no_candidates`, sessions
  drain faster than they fill), trust (0/20,955 accepts human-annotated — owner was never a gate). **Rank/salience
  collapse is a SYMPTOM, not the constraint** (a learning ranker can't discriminate over a 91%-never-read pool because
  its training signal IS read-back). Do NOT re-headline rank as the constraint in later reviews — that re-triggers the
  #682 tuning investment this review audits.
- **Effort-vs-constraint audit (named failure-mode instance):** the month's dominant engineering stream —
  `improve-pipeline-deep-tuning-analysis.md` (17 HIGH items, zero aimed at the leak), PR #682 self-learning wiring
  (+2,944/−1,039; its outcome-loop centerpiece measured DEAD within a week: `outcome-proxy-dead` |corr|=0.064,
  `salience-uniformity-collapse` Gini 0.0404), 303/728 commits/30d on `src/commands/improve` — sits **entirely upstream
  of the leak**. `memory:akm-improve-success-metric` warned against exactly this ("do NOT optimize promotion
  volume/churn") *before* the investment. `docs/technical/akm-production-readiness-findings.md` (Postgres multi-writer
  for a single-writer/single-owner deploy) was **stale the day it landed** → route to review-14 doc-sync (update/archive,
  owner call — NOT deletion).
- **The ONE move (stage REMOVAL, already ratified across 03/06/09/10):** remove the autonomous minting stage —
  E2 (extract 48×/day → nightly + drain routing), proactive lane OFF (fails 5% floor: 1.55% this session), delete
  `session_checkpoint --force` writes (03-R1/06-M1) + `recombine.ts:233–258` filters, delete `update --all` cron
  (06-M2). Second-order once gone: signal density recovers → rank work becomes possible on real signal; the ~13k/15k
  monthly accepted-proposal flood stops (slows `result_json` growth); GRR becomes a readable instrument.
- **ADJUDICATION (owner, 2026-07-04) — the three calls resolve to ONE ordered plan:**
  1. **D1 = DEFER shutdown UNTIL beta.57+ CLEAN.** Shutdown approved in substance (components stay ratified) but gated
     on measurement integrity: **ship beta.57+ (G5 provenance fix, PR #701) to the cron dist FIRST** so before/after is
     measured on clean `usage_events`. The expected post-shutdown DROP in numbers is correction (self-reads finally
     tagged), NOT regression — do not panic-re-expand minting when numbers fall (§6 caveat is load-bearing).
  2. **D2 = FREEZE NEW tuning, FINISH IN-FLIGHT.** No new salience/tuning/outcome-loop work and no new pipeline
     analysis docs; in-flight salience work may reach a clean stopping point only. Nothing new starts until shutdown
     lands AND **≥30 days of clean `improve_cycle_metrics`** exist (11 rows / 2 days now). Rank = symptom ruling stands;
     first rank touch after the freeze = **02's approved curate-golden ablation**, not new machinery.
  3. **D3 = NEXT SERIES UNIT = EXECUTION BATCH, not review 13.** The adjudication→execution gap (5 of 11 reviews
     "nothing executed") is accepted as the meta-constraint. Resulting sequence: (1) ship beta.57+ to cron dist →
     (2) accrue clean events + re-run `findings/09-grr-receipt.sql.md` as the before-baseline → (3) execute the §4
     shutdown batch on that baseline → (4) hold all tuning until +30 clean days.
- **NEXT constraint (prediction, so the owner sees the next link):** once minting stops, the constraint moves to
  **retrieval precision at genuine use** (curate/SessionStart surfacing the right asset) — masked today by the flood
  (only 998 distinct refs ever shown, 232 ever with feedback — too sparse to tune on). Behind it: **single-owner demand**
  itself (09 Bet-4; npm `latest`=0.8.14, zero telemetry). **Anticipation guard:** when engagement plateaus post-shutdown,
  the reflex to restart minting is exactly wrong — sequence via existing instruments (curate-golden + 02 ablation, then
  E6 second-corpus probe), build nothing new until they report.
- **Sealed-prediction outcome:** HALF-CONFIRMED, HALF-INVERTED — owner sealed "combo of capture and improve." Improve
  half CONFIRMED and sharpened (right subsystem; the leak is its read-back link, fix = remove not tune). Capture half
  INVERTED — analysis argues capture is *over-provisioned* (waste feeding the dead pool), so the correct capture move is
  also subtraction (nightly), same shape as the improve fix; both ride the one batch.

From **13 bus-factor** (adjudicated 2026-07-05; nothing executed — dispositions only):

- **The bus-factor shape:** risk concentrates in ONE gitignored file + TWO silent mechanisms, NOT in docs
  gaps. `~/.config/akm/config.json` is the only copy of 3 cron-load-bearing improve profiles behind a
  silent unknown-profile fallback (proven −96% incident class); state.db grows ~4.4GB/month from per-asset
  `distill-skipped` records (~13k/run, 91% of result_json bytes — the 90-day TTL cannot bound it, per-run
  rows grew 10×); a live 15–16% cron failure rate is invisible (`taskFailRate` computed + rendered but
  never wired into `checks.ts` advisories; exit-143 spike undiagnosed).
- **APPROVED (new work, next execution batch):** [A1] DELETE the silent fallback in
  `improve-profiles.ts:128-133` (unknown profile = hard ConfigError) + promote `reflect-distill`/
  `proactive-maintenance`/`recombine-only` to `src/assets/profiles/` builtins — `default.json` untouched
  (11-§3.2 HOLD). [C1] **RE-OPENS the wait-until-GA blob decision:** stop persisting per-ref
  `distill-skipped`; aggregate `{reason→count, capped samples}`; move the one consumer
  (`improve-metrics.ts:284`); then the ratified prune list executes. [C2] wire `taskFailRate` into
  `checks.ts` advisories (5% threshold from html-report) + triage the exit-143 spike as a priority bug.
  [B1] ~30-line committed advisory→action doc for the health warns. [A3] ~25-line fresh-host rebuild
  runbook + ONE versioned config.json copy in stash git (08-F1 pattern).
- **APPROVED per-path trash (gio trash, owner named each path; execute in batch):** `~/akm/.akm/state.db`
  (0-byte decoy), `~/.local/share/akm/state.db.bak-20260614` (2.6GB), 2 orphan `config-backups/` dirs,
  18 `config.json.bak-*` files (the .baks only AFTER the A3 stash-git copy exists). ~5.5GB reclaimable.
- **NEW D1 (from the sealed prediction — the audit's blind spot, owner-confirmed + quantified):** ~500
  curated stash assets (379 knowledge, 99 memories, 7 workflows, 7 skills, 5 scripts) contain
  `/home/founder3` absolute paths → stash is not machine-portable. APPROVED both fixes: one-shot
  normalization pass (`$HOME`/`~` rewrite, owner-reviewed diff) + write-time lint/advisory against
  absolute host paths in asset content. Also a fresh-install product-bug class, not just this host.
- **SEQUENCING:** the pure-execution items (08-F3 uninstall/fallback-branch delete, 08-F4 host cleanup,
  08 `surfaces` dist-skew fold-in, 09 latest-repoint) ride the NEXT execution batch alongside the 12-D1
  shutdown sequence; only doc lines (bun-shim correction, logs.db in storage-locations, the VACUUM
  sentence — verify `auto_vacuum` first) wait for review 14's doc-sync batch.
- **Defended KEEPs (binding):** flake taxonomy stays in memory + lock error-text stays the runbook (B3,
  reaffirms 11's SPLIT); resolved-proposal rows are NEVER purged — they are the audit trail 10 named as
  the moat (C3; re-examine only if post-shutdown growth >100MB/yr).
- **META-RULE AMENDMENT (B4, binding on future reviews):** cite memories by SEARCH-TERMS, not exact ref
  names — memories rename/merge under improve, so exact refs rot (6 of 13's prompt refs were
  ASSET_NOT_FOUND). No alias/redirect machinery.
- **DON'T-ADD (extends prior lists):** no cron-builds-own-dist; no doctor cron; no config-sync machinery;
  no in-code acknowledged-advisories layer; no new alert channels; no logrotate for flat logs; no
  per-table retention knobs; no proposal purge; no improve `--force` flag.
- **Sealed-prediction outcome:** PARTIAL MATCH + ONE AUDIT MISS — owner called cron/dist first-to-break
  (audit agrees, ranks it low-cost with ratified fixes) but not the top two silent mechanisms (profile
  fallback, blob growth); the owner's top concern (absolute paths in stash assets) was MISSED by the run
  entirely and confirmed real post-hoc → D1.

From **14 docs-consolidation** (adjudicated 2026-07-05; nothing executed — dispositions only; these
form the **doc-sync batch** that 13's sequencing note reserved for 14):

- **Headline:** `docs/README.md` — the stated entry point — is the broken router (3 dead links whose
  targets exist only under gitignored `.plans/done/`, latest=0.8.0 vs shipped 0.9.0, six doc areas
  unreachable), and 12 of ~60 live design/technical docs are already SHIPPED or SUPERSEDED. The
  archive convention (`docs/archive/README.md`) existed all along and was skipped 12 times — a
  process failure, not a subsystem one. Fix shape = **zero new docs**: edit 2 existing indexes, net
  −12 live docs.
- **APPROVED — archive 12 per-path by name** (moves to `docs/archive/` with 2-line banners, git
  history is recovery): `technical/v1-architecture-spec.md` (5-way code-contradicted; DB_VERSION 9 vs
  live 17), `technical/d1-design.md` + `d2-design.md` + `d3-design.md` + `r5-design.md` (all four
  code-verified shipped), `technical/health-command-enhancements.md` (fix/drop the README:34 link),
  `technical/proposal-storage.md`, `technical/improve-pipeline-analysis-0.8.0.md`,
  `technical/index-consistency-adr.md`, `technical/akm-production-readiness-findings.md` (banner
  cites 10-Q4 — owner chose ARCHIVE over update, closing 12's open call),
  `design/improve-vs-brain-analysis.md` + `design/improve-pipeline-deep-tuning-analysis.md` (both
  superseded BY NAME by `improve-self-learning-analysis.md`).
- **APPROVED — MERGE-FIRST then DELETE** the 486-line near-duplicate
  `technical/claude-code-workflows-vs-akm-workflows.md`: diff against the keeper
  `claude-code-vs-akm-workflows.md` (the one anchored by `akm-workflows-orchestration-plan.md`'s
  supersession chain), port unique paragraphs into the keeper, then delete. NOT a straight delete.
- **APPROVED — edit-in-place set (all):** README router rewrite (drop the 3 dead `.plans/` links,
  0.8.0→0.9.0, one route per subsystem incl. the 6 unreachable areas); "Section 0" prepended to
  `design/self-improvement-learning-memory-reference-index.md` (subsystem→doc→status table — extend
  the existing index, NO new index file); `technical/storage-locations.md` one batched edit
  (DB_VERSION 17, events schema `id/event_type/ts/ref/metadata_json`, add logs.db ~1.06GB +
  akm-claude/akm-opencode state tiers, backup truth = one live $CACHE/config-backups, perms line +
  `data-and-telemetry.md:51`); `technical/improve-workflow.md` 2 fictions (human-in-loop →
  audited-autonomous per 06; delete the confidence-threshold claim — no such score exists, 06-M7);
  `technical/architecture.md` + `migration/v1.md` add shipped `lesson`/`fact` types;
  `design/improve-salience-working-reference.md` (re-anchor all improve.ts cites to SYMBOLS — every
  line-cite points past EOF of the 1,454-line post-D1 file; fix F7 default-OFF → ON per
  `salience.ts:355`; repoint :357 to `improve-self-learning-analysis.md`); 3 one-liners
  (neuroscience-survey gets "inspiration, not justification" header and KEEPs as the grading source;
  `improve-optimal-default-config.md` gets the 06-M5 ratified-unexecuted status note;
  `src-reorganization-plan.md` ghost `490-refactor-plan.md` reference deleted).
- **APPROVED — the 5-line new-docs rule** (README footer): one current-truth doc per subsystem;
  unshipped designs in `docs/design/` with mandatory Status/Supersedes/Date header; the SHIPPING PR
  moves the design to `docs/archive/` in the same PR; cite code by SYMBOL + memories by search-terms
  (11-B4/13-B4); nothing in `docs/` may reference `.plans/` (scratch — promote or drop); per 12-D2 no
  new improve-analysis docs until the 30-clean-day gate.
- **APPROVED — supersession (owner resolved flag):** `src-reorganization-plan.md`'s indexer half is
  SUPERSEDED by `docs/analysis/indexer-vertical-slice-refactor-plan.md` (2026-07-03) — add the note.
- **Defended KEEPs (binding):** `storage-locations.md` (only storage inventory — edit, never archive);
  `improve-salience-working-reference.md` (the only per-claim-cited improve map; stash knowledge
  defers to it); `search.md` + `search-updated.md` pair (self-declared companion, no rename churn);
  `.plans/` untouched (gitignored user data, ZERO file operations — the fix is the rule, not
  promotion). Review-13 doc leftovers (bun-shim, VACUUM) CLOSED as no-ops — zero matching doc lines
  exist. Stash-vs-repo: NO contradiction (all 3 stash knowledge refs defer to repo docs); fold
  `config-system-architecture`'s still-true "Missing Process Schema" known-issue into
  `docs/configuration.md`.
- **Routed elsewhere:** npm `latest`=0.8.14 repoint (already in the 08/09 hygiene batch); the weekly
  YAML "disabled-by-default" false claim is a LIVE STASH ASSET → its one-line correction rides the
  execution batch, not the doc-sync batch.
- **DON'T-ADD:** no new index file, no new orientation doc (04-B7 already covers `meta/index.md`),
  no doc-lint tooling — the 5-line rule + ship-PR convention is the whole mechanism.
- **Sealed-prediction outcome:** STRONG MATCH on rot density, DIVERGE on worst artifact — owner
  sealed "improve pipeline docs"; 7 of 17 contradiction rulings ARE improve docs (churn→rot theory
  confirmed: D1 refactor + betas 44–59 invalidated cites and turned passages into fiction), but the
  single most-contradicted doc is `v1-architecture-spec.md` and the headline is the broken router —
  a structural failure no subsystem guess would name.

## EXECUTION BATCH 1 (2026-07-04) — what SHIPPED / BLOCKED / REMAINS

First execution session against the ratified dispositions (branch `meta-review-exec-2026-07-04`, off
main 074ef2df in akm and off `release/0.9.0` 0965e66 in the SINGULAR akm-plugin). One-item-per-commit,
each gate-green (`bun run check` / `bun test tests/`) + adversarial code-review. **Do NOT re-do the
COMMITTED items.**

**akm — COMMITTED (11 commits):** [02] curate_rerank dead-key delete `d171ef0b`; [06-M7] dead
`autoAccept` param + extract `maxDiffLines` cap `fbb3d93f`; [06-M4] archive-on-validation-throw
`56ae805b` (gated on **structured `UsageError` code**, NOT message-sniffing — a transient git-push
`[rejected]` was a false positive); [03-R4] null content_hash on llm_unavailable/triaged_out `015fd07b`;
[07 P0-1] registry.md scanner-claim fix `ea881294`; [07 P0-3] extract-transcript fence `6c85020b`;
[07 P1-B akm] workflow_started event → `{runId,status}` `3e2c0b4a`; [07 P1-D] show-layer toolPolicy
ceiling `407c09fe` (keys off **primary-stash identity**, and `findSourceForPath` is now longest-prefix
— NOT registryId/writable, which both had bypasses); [08-F2] distill env/secret structural refusal
`b1d3f0b9`; [08-F4] config backups 0600 file + 0700 dir `34a99678`; [08 health] `stash-git-exposure`
advisory + `.gitignore` env/secrets scaffold `c9ddd0e5`.

**akm-plugin — COMMITTED (1 commit `48f9345`):** [07 P1-B plugin] SubagentStart drops raw workflow
title/params; [07 hardening] provenance-tag on recalled/curated content (interim captureMemory
mitigation — the WRITE deletion stays deferred behind the shutdown gate).

**BLOCKED / RE-SCOPE / SUBSUMED:**
- **[07 P0-2] quality-gate fail-CLOSED — BLOCKED, change READY+PROVEN, reverted.** Flipping
  `quality-gate.ts` fail-open→closed is correct (5 unit tests pass) but breaks ~30–50 distill/reflect
  *mechanics* tests that relied on the judge failing OPEN (their chat stubs supply no judge verdict).
  Needs a dedicated test migration (inject a passing judge via `options.chat` for reflect; judge-aware
  stub or disable `distill.qualityGate` in per-file `configEnabled` for distill). **P0 security — do
  this FIRST next session.** Ready diff + proven test saved off-repo.
- **[10-Q3] retire staleness-detect — NEEDS-RE-SCOPING (owner confirm).** ~15 files; the
  `StalenessDetectionResult` type threads through the improve pipeline output; 04 kept-OPEN vs 10-DELETE.
  Reported per the CAUTION, not forced.
- **[07 dispatch-D] plugin toolPolicy ceiling — SUBSUMED by P1-D (item `407c09fe`).** Both dispatch
  paths consume `akm show` output (now ceilinged at source); a plugin-side re-check would re-introduce
  the registryId weakness P1-D fixed. DON'T-ADD.

**REMAINING (not executed — next session):**
- [03] delete two `type==="memory"` belief guards; [03-R3] supersede base on `.derived` + delete
  `derivedBoost`; [02] contributor ablation — all **curate-golden nDCG/MRR Δ-gated** (need eval runs).
- [03] one-**directed**-edge contradiction fix (`memory-contradiction-detect.ts` mutual A↔B → one edge)
  — **behavioral gate** (edges persist across a read-only re-run), NOT eval-gated → most tractable.
- [03/10-Q5] opencode-sdk `sessionLogs=false` reader — confirmed lives in **akm** (`opencode-sdk/index.ts:27`);
  needs storage verification (SDK sessions land in `opencode.db`?) before wiring the reader.

**⚠ OWNER RELEASE STEP:** the akm-side security fixes only reach the cron dist after `bun run build` +
reinstall of the global (~beta.58). Committing alone does NOT protect cron. This ALSO satisfies the D1
precondition (beta.57+ on cron) — after it, accrue clean events → re-baseline via
`findings/09-grr-receipt.sql.md` → then the deferred minting-shutdown batch can run.

## EXECUTION BATCH 2 (2026-07-04) — resumed on branch `meta-review-exec-2026-07-04`

Continued off batch-1 head. Same process (one item/commit, TEST-FIRST, `bun run check` green +
adversarial code-review + apply findings before commit). Base re-confirmed green (12 ahead of main,
0 behind; baseline check exit 0) before starting.

**akm — COMMITTED (3 commits):**
- **[07 P0-2] quality-gate fail-CLOSED** `4866371d` (+245/−39, 15 files) — the reverted P0 security fix,
  now landed. Flipped all three fail-open returns in `runLessonQualityJudge` (no-LLM / parse-failure /
  timeout) from `pass:true`→`pass:false`; unjudgeable minted content is now `quality_rejected`, not
  passed through. Test migration: distill mechanics tests disable the (default-on) gate via
  `qualityGate:{enabled:false}` in the per-file config helpers; reflect mechanics tests use a shared
  `quietQualityGateConfig()` (the no-LLM branch fires FIRST in the sandbox, so injecting a passing judge
  chat can't help — must disable the gate). New `quality-gate-fail-closed.test.ts` (unit) + an end-to-end
  `akmDistill` reject test. Reviewer findings applied: 3 stale "fail-open" comments fixed
  (`distill.ts`, `promote-memory.ts`, and the load-bearing `feature-gate.ts` default rationale) + the
  end-to-end test added.
- **[03] one-directed-edge contradiction fix** `305fc2da` (+172/−29, 2 files) — behavioral gate met.
  Write ONE directed edge (loser by **lexicographic ref order = a total order → provably acyclic**),
  not mutual A↔B. Reviewer finding applied by SUBTRACTION: the speculative `createdAt`-recency branch
  was **deleted** (no writer sets `createdAt` — verified in `memory-inference.ts`; it was dead code AND
  a 3-cycle landmine when `createdAt` is inconsistent within a family). Legacy mutual edges **self-heal**
  via the resolver (it deletes both `contradictedBy` arrays on the 2-cycle refresh, then next detection
  writes the canonical single edge). Migrated the test that asserted the buggy `edgesWritten===2`; added
  a persistence test (survives resolver + read-only re-run) and a 3-memory-family acyclicity test.
- **[03] belief penalties reach flagged knowledge + drop derivedBoost** `41b797ca` (+50/−41, 5 files) —
  deleted the two `type==="memory"` guards (`db-search.ts` matchBeliefFilter — dropped the now-unused
  `type` param; `ranking-contributors.ts` beliefStateBoost) AND broadened the (renamed)
  `beliefStateRankingContributor` to fire on any belief-state-carrying entry (the ranking guard deletion
  is INERT without this — beliefStateBoost was only called from a memory-gated contributor). Deleted the
  `derivedBoost` constant (03-R3). **Gate met: curate-golden Δ=0** (mean 0.890/ndcg 0.854/mrr 0.900/
  0-leapfrog — golden has no flagged/memory entries). Reviewer doc findings applied (stale JSDoc in
  `search.ts`, stale rationale comments in `search.test.ts`, stale module-docstring paths).

**NEEDS-RE-SCOPING (verified, not forced):**
- **[03-R3] "supersede base on `.derived` write" — NOT executed (direction is contradictory in the source
  dispositions).** R-3's label says *supersede the base* (demote it), but 04's structural-leak text says
  the STALE FLAG-FREE TWIN outranks the corrected base (so the TWIN should be demoted / inherit the flag,
  not the base). The two point opposite ways, and the citation (`ranking-contributors.ts:153-162`) is the
  ranking file while "on `.derived` write" implies the `memory-inference.ts` write path. Deleting
  `derivedBoost` (done) already shrinks the twin leak (twin +0.12 boost removed). Needs owner clarification
  on the intended direction before the write-path half is safe to build.
- **[02] contributor ablation — measured, 0 safe deletions (gate is insufficient).** Ran per-contributor
  ablation on curate-golden: **12 of 13 `defaultRankingContributors` are Δ=0** and `typeRankingContributor`
  removal even *improves* it +0.003. But Δ=0 here means the 10-case golden corpus **doesn't exercise** the
  contributor (no memory/lesson/fact/flagged/graph/project-context/exact-name paths), NOT that it's useless.
  Mechanically deleting the Δ=0 set would delete `belief-state-ranking` (just shipped), `exact-name-ranking`
  (core), `graph`, `project-context`, and all type-specific boosts — regressing real queries the corpus
  can't measure. The gate (curate-golden Δ≈0/contributor) is **necessary but not sufficient**; the real
  prerequisite is the **E6 second-corpus probe** (09 Bet-4 / 10). 0 LOC deleted by design.
- **[03/10-Q5] opencode-sdk `sessionLogs=false` — verified; the "fix the reader" framing is a misdiagnosis.**
  SDK sessions land in the **shared** `~/.local/share/opencode/opencode.db` (the SDK server uses opencode's
  default store — no isolated dir), the **same store the `opencode` CLI harness already reads**. They are
  **DELETED per-dispatch** (`sdk-runner.ts:277-278`, `session.delete` in the finally block, explicitly "to
  prevent disk accumulation") and titled "akm" (akm-internal improve/wiki/propose dispatches, not user
  coding). So there is **no reader gap** — flipping `sessionLogs=true` on opencode-sdk would cause
  **DUPLICATE discovery** (both harnesses enumerate the same db → double extraction), violating the gate's
  own "don't break existing readers" constraint. The real fix needs an **owner decision** on a genuine
  tradeoff: (a) stop deleting + dedup SDK sessions against the `opencode` harness + accept opencode.db bloat
  from one-shot akm-dispatch sessions, OR (b) capture the transcript to an akm-owned session asset (new
  persistence path = machinery). Neither is the clean "wire the reader / flip the capability" the disposition
  assumed. The extract value is also questionable (akm mining its own agent dispatches — circular).

**OWNER RESOLUTIONS (2026-07-04, on PR #706 review) — the three NEEDS-RE-SCOPING items are now decided:**
- **[03-R3] = DEMOTE THE TWIN (propagate the flag) — SHIPPED in this PR (`71fcc875`).** Owner asked for it in
  the same beta, so it landed on this branch. Implemented as **search-time inheritance**, NOT a frontmatter
  write: a `.derived` twin with no state of its own inherits its base's demoting belief state into its
  in-memory ranking entry, so the (03) belief ranker + filter demote it. A persisted copy was rejected after
  verifying the **SCC resolver erases any non-frozen state** written to a derived memory on the next improve
  run (only `deprecated` is frozen). Applied on both the FTS-scored and enumerate/browse paths. Gate:
  curate-golden Δ=0 + integration tests (demotion below an identical unflagged twin; browse-path filtering).
- **[02] contributor ablation = DEFER to the E6 second-corpus probe.** No contributor deletions until a
  broader eval corpus actually exercises the paths curate-golden can't (memory/lesson/fact/flagged/graph/
  project-context/exact-name). The curate-golden Δ≈0 gate is insufficient on its own. 0 deletions; closed.
- **[10-Q5] opencode-sdk `sessionLogs=false` = WON'T-FIX (drop).** Keep `sessionLogs=false` + the
  per-dispatch `session.delete`. SDK sessions are akm's own internal agent dispatches (improve/wiki/propose)
  in the shared `opencode.db`, deleted to avoid bloat; feeding them to extract is circular/low-value and
  would double-count against the `opencode` harness. Closed as won't-fix — do not re-investigate.

**⚠ OWNER RELEASE STEP (unchanged, now covers batch-2 too):** the batch-2 akm-side fixes — especially the
07 P0-2 quality-gate fail-CLOSED — only protect cron after `bun run build` + global reinstall (~beta.58).

## SHIPPED & DEPLOYED (2026-07-05) — batches 1+2 are LIVE in cron

Everything above is now merged, released, installed, and verified running. This closes the
adjudication→execution gap (12-D3) for the security/correctness half of the series.

- **PR #706 MERGED to main** (squash `597cadea`) — all 19 commits (batch 1 + batch 2 + 03-R3 +
  resolution docs). Released as **`akm-cli@0.9.0-beta.58`** (npm `next` dist-tag; version bump
  `537bc38b`). First release run FAILED on the #499 test flake (below), re-run succeeded.
- **Global reinstalled to beta.58** (`bun add -g akm-cli@0.9.0-beta.58`) — the owner release step is
  DONE. All three wrapper modes report beta.58 (stable/build/default).
- **Verified LIVE in cron 2026-07-05** (the crontab invokes the global `dist/cli.js`): beta.58 installed
  20:34, cron tasks ran after (frequent 21:51 / quick 22:02 / extract 22:06), **all `exitCode 0`**. Latest
  `akm-improve-quick` processed 74 actionable refs (real work), **0 config errors** (the old
  `INVALID_CONFIG` lines were historical, not recurring), **0 spurious "failing closed" events** — the
  lmstudio judge endpoint is UP (HTTP 200), so the fail-CLOSED gate passes legitimate content and does not
  starve the pipeline. `akm health` = `warn` (advisories, not errors). So the D1 "beta.57+ on clean cron"
  precondition is now satisfied — the deferred **minting-shutdown batch** can proceed on a clean baseline
  (re-run `findings/09-grr-receipt.sql.md` for the before-number first).
- **#499 release-flake root-caused + fixed + guarded — PR #707 MERGED** (squash `ec20aeb6`; test/lint-only,
  no new release needed). The flake was NOT the long-assumed XDG env race (that half was already fixed via
  `withIsolatedAkmStorage`); the true cause was **non-atomic `Date.now()`**: the health wallTime tests built
  `taskStart`/`taskEnd` from two separate clock reads and asserted their delta exactly (`toBe(22000)`), so a
  loaded CI shard's ≥1ms gap → 22001+ → fail. Fixed by capturing the clock once; added **Rule 7** to
  `scripts/lint-tests-isolation.ts` (flag ≥2 `new Date(Date.now() …)` per scope, no allowlist) so the whole
  class is now un-writable. Corrected `memory:akm-brittleness-and-flake-rootcause` (it had the wrong cause).

**GitHub issues:** the executed items were disposition-tracked here (findings/ + this file), not as 1:1
GitHub issues, and the underlying FEATURE issues were already closed before this work — so this work
HARDENED already-shipped features rather than closing new issues. Traceability comments added to the
directly-affected closed issues: **#367** (M-1 contradiction pass → the mutual-edge bug it introduced is
fixed by 03's one-directed-edge change), **#374** (R-5 lesson_quality_gate on reflect → hardened by 07
P0-2 fail-CLOSED), **#499** (per-run wallTime → its test flake fixed by #707). No currently-OPEN issue is
completed by this work (#692 R2-salience-gate remains genuinely open; the rest are unrelated features).
