# akm ui overhaul: plan

**Path in the repo:** `docs/design/ui-overhaul/plan.md`

**Status:** final. This document is **the source of truth for the epic and every child issue.** A child issue cites sections of this file by number (§x). It does not restate them; where an issue and this plan disagree, the plan wins. To change the plan, open a PR to this file that adds a row to the decision register (§0) and gets the owner's approval.

**Section numbers are frozen.** Later edits append sections (§14 and on) or sub-sections. They never renumber.

**Version:** v2, 2026-11-01. It reconciles:
- the five design inputs: the visualization plan, the UX, front-end, data-analyst and a11y reviews;
- the three final reviews of v1: design director (**DD**), staff architect (**SA**) and dataviz/a11y lead (**DVA**).

**Conventions**
- Paths are relative to the repo root `src/` unless they start with `docs/`, `tests/`, `scripts/`, `.github/` or `node_modules/`.
- `file:line` references were checked against the code on 2026-11-01. Line numbers drift, so treat each one as a hint and search by name.
- **[uncertain]** marks a claim not confirmed in code. The task that relies on it must confirm it first.
- Identifiers:
  | Prefix | Meaning | Section |
  |---|---|---|
  | `D-xx` | decisions | §0 |
  | `V-xx` | visuals | §5 |
  | `M-xx` | metrics | §6 |
  | `B-xx` | bugs | §9 |
  | `G-xx` | data gaps | §10 |
  | `R0–R4`, `R2a` | review gates | §11 |
  | `P<phase>-<n>` | tasks | §12 |
  | `Q-xx` | owner questions | §13.2 |
  | `S-xx` | standards checklist items | §8.8 |
- **Reviewer roles** (§11):
  | Code | Role |
  |---|---|
  | **VD** | visual designer |
  | **AX** | accessibility/interaction |
  | **DV** | data visualization/analytics |
  | **CD** | content (folded into VD unless the owner assigns one) |

---

## 0. Decision register

Rows marked **v2** are new, or were changed by the final reviews. A superseded row names the row that replaces it.

| ID | Topic | Decision | Reason (one line) |
|---|---|---|---|
| D-01 | Improve-impact comparison | **v1 ships a per-asset *Linked* table (V-15) with no effect number, no difference column and no comparison or context row.** The matched comparison is P6-3 (spec in §5.4), at n ≥ 20 per group with a placebo check. **v2:** the context row is removed (DVA MF-11) | Budget-skipped assets are lower salience, contaminated by later runs and selected on acceptance. A pooled context row invites the subtraction we forbid |
| D-02 | Baseline | **p-chart** with **one fixed centre** pooled over the 8 blocks or weeks before the latest one. **Exact binomial limits** (0.135% and 99.865% quantiles), widened by Laney's σ_z when σ_z > 1.5. Signals only after the baseline period. **v2** (DVA MF-01/02) | A 3σ normal limit fires 3–9× too often at n ≈ 30. A moving centre absorbs drift. Repeated agent queries overdisperse |
| D-03 | Pulse tiles | **3 tiles:** "Found nothing" (V-01), "Negative feedback" (V-02), "Runs finishing" (V-03). **v2:** they use **trailing 7-day blocks** anchored at today 00:00 UTC, never ISO weeks | The tile number must equal the last sparkline point. 12 blocks (84 d) fit within 90 d retention |
| D-04 | Texture (decals) | Off by default. Turned on by `(forced-colors: active)` or `(prefers-contrast: more)`. No UI toggle. **v2:** this requires `aria.enabled:true` (D-29) | Meaning is carried by labels, shapes and order. Decals exist for the modes that remove colour |
| D-05 | Navigation | **v2** (DD SF-7): `Overview · Search` / **REVIEW:** Proposals (count), Improve impact, History / **SETUP:** Bundles & index, Config. "New knowledge" becomes a button on the Search header and in the Misses empty state. Changes → History; `#/asset/<ref>`; old hashes redirect | Frequency order, nouns only, and no one-item section |
| D-06 | Undo | A persistent **status bar** (no timer) with Undo, which calls revert at once. Revert elsewhere uses an inline confirm. No toasts. **v2:** no Undo after a *batch* accept; batch results link to Recent, where each row has Revert (SA MF-6) | WCAG 2.2.1. Batch undo is not atomic |
| D-07 | Accept confirm | One action for revertable proposals (edits with a backup, retirements). Creates keep the inline confirm. The server computes `revertable = status==='accepted' && (isRetireProposal(p) \|\| p.backupContent !== undefined)` and never sends `backupContent` | Confirm only what cannot be undone. Revert throws "no backup" for creates (`commands/proposal/repository.ts:2325-2328`) |
| D-08 | Charts window | **Superseded by D-30** | — |
| D-09 | Theming | Tokens written as `light-dark()`. `:root[data-theme=light\|dark]` sets `color-scheme`, and a System/Light/Dark control is stored in `localStorage`. JS reads colours **only** through `resolveColor()` (a probe). **v2:** the probe lands in P2-2 itself (SA MF-2) | `getPropertyValue` returns the literal `light-dark(...)` string, which ECharts cannot parse |
| D-10 | CSS files | Flat files, one per layer. `index.html` links `layers.css` first, then the six layer files. **v2:** done in two steps: P2-1a wraps layers in place, then P2-1b splits the file (SA MF-3). `EMBEDDED_UI` is generated (P0-4) | Layer precedence changes the cascade, so the diffs must be fixed before the files move |
| D-11 | ECharts Tooltip | Add `TooltipComponent` only, with `renderMode:'richText'`, `confine:true`, `enterable:true`, `transitionDuration:0`, `hideDelay:300` and Esc to hide. The text goes through `richSafe`. **v2:** a hover enhancement only (D-28) | One readout for pointer users. No second `innerHTML` path. WCAG 1.4.13 |
| D-12 | Sparklines | Inline SVG, never ECharts | Three tiles must not load 190 KB |
| D-13 | Proposals backlog chart | An HTML table plus an inline-SVG age bar on the validated sequential ramp (§7.1 `--age-*`). **v2:** delivered early as P1-10 | No ECharts on Proposals before P2-6a, and no porting of a chart that will be deleted |
| D-14 | Tiers | Recorded · Classified · Linked · Correlated. Each visual shows its tier and window as visible text | Honest attribution |
| D-15 | Harm | Never netted. A "first negative after a change" is a **flag**, shown with a defined base rate and an eligibility count (§5.2 V-13) | A change is not a random event |
| D-16 | Kept | Accepted ≥ 14 d ago and not reverted. **v2:** "kept" appears only on Improve impact, never on Overview (DVA MF-07) | Censoring |
| D-17 | Accept-rate table | Removed from Overview. A cohort "you accepted k of n" appears in V-10 | All-time, drops reverts, pools deciders |
| D-18 | Density toggle | Cut | One-person tool. It doubles the baselines |
| D-19 | Config writes | Read-only. Each row has a "How to change" disclosure with the command template | Write surface undecided (Q-11) |
| D-20 | ⌘K palette | P6. Ctrl/Cmd+K focuses the Search field | Scope |
| D-21 | Content width | `--content-max: 80rem`, centred. Reading surfaces use `72ch` plus a rail. **v2:** layouts change at the named container sizes (D-27b), not at ad-hoc widths | At 1440 the page container is 71.25 rem; at 1280 it is about 61 rem |
| D-22 | Type scale | 6 steps (§7.1), root `100%`, roles mapped in §7.0 | Respect the user's default font size |
| D-23 | Misses | No-result queries only, recent and repeat. Low-select waits for G10 | Selects carry no source |
| D-24 | Set-up rows | Folded into Needs attention. Mapping: `connections-and-harnesses` → model connection; `scheduler-binary` → schedule; bundle git status from `/api/bundles` → git repo (SA MF-18) | One attention surface |
| D-25 | Improve window | 90d (default) · All. **v2:** "All" covers **proposal-based** sections only. `improve_runs` and `events` are purged at 90 d (`commands/improve/loop-stages.ts:738-755`), so cost and run marks stop at the data-start rule | Retention differs per store |
| D-26 | Event strip | One component. Marks are snapped to the host chart's category bins, with a count when several share a bin. **No chart uses a time axis** (DVA MF-05). v1 marks: improve runs ok and failed, full reindex, retirement batches. Config changes come after G9. No version marks | A time axis under a category axis misaligns marks by half a bin |
| D-27 | Overview volume tiles | **v2, replaces v1** (DD MF-5): **no volume tile row.** Each card header shows a total line ("212 searches · 13 found nothing"). The pending count lives in Needs attention and the nav badge. The window control sits in the "Trends" section header | One window per visual region. Tiles are reserved for "how well" |
| D-27b | Size vocabulary | **v2** (DD MF-1): one media breakpoint `50rem` (shell). Three container sizes: `narrow` < 30rem, `medium` 30–60rem, `wide` ≥ 60rem. Plus `56rem` for the diff pane only. No other `@container` lengths (lint) | The layouts must fire at 1440 and 1280 |
| D-28 | Chart keyboard model | **v2** (SA cut vs DVA MF-18): **cut the arrow-key stepping model from v1** (it moves to P6-8). The chart node is a **non-focusable `role="img"`**, `aria-labelledby` the `<h2>` question and `aria-describedby` the takeaway. The ECharts SVG is `aria-hidden`. Every drill-down is reachable from **buttons in the data table**, and the takeaway says so | The table already meets 1.1.1/2.1.1. This removes DVA's semantic objection (a focusable `img` acting as a widget) and one complex component |
| D-29 | ECharts aria | **v2** (SA MF-1, confirmed in `node_modules/echarts/lib/visual/aria.js:60-63`): `aria: { enabled: true, label: { enabled: false }, decal: { show: <media> } }`. This overrides DVA's checklist line "aria.enabled false" | Decals never render when `aria.enabled` is false |
| D-30 | Charts window | **v2** (DVA cut 7d; DD default 30d; SA sequencing): **30d (default) · 90d.** `?window=24h\|7d` redirects to 30d. P3-2 ships 30d fixed, with the window chip; P5-3 adds the segmented 30d/90d control once P4-1 provides weekly bins | At 7d every weekly rate collapses to a stat. The pulse already covers 7 days |
| D-31 | Activity card (V-07) | **v2** (DVA cut): replaced by a **"Feedback and use"** card: the recent negative feedback table plus a one-line text of counts | Activity answers neither user question. Mixing curates with searches hides the smaller series |
| D-32 | Retirement follow-through (V-16) | **v2** (DD, SA and DVA agree to cut the section; DVA kept lost queries in harm; DD said "only if cheap"): **the whole follow-through join, including the lost-query harm row, moves to P6-2** | It is the most complex join, mostly n < 5, and it shortens the Improve critical path |
| D-33 | "Since your last visit" | **v2** (DD and SA cut; DVA proposed a second line): **cut from v1** | Hidden per-viewer state is untestable in baselines |
| D-34 | Process colour map | **v2** (DVA MF-14 vs DD MF-6): **deleted.** Process identity is carried by small-multiple rows and labels. Bars by process use one hue | All-pairs CVD validation fails for 5 process hues |
| D-35 | Marks and shapes | **v2** (DD MF-4 vs DVA MF-13 differ in detail): **one merged table, §7.6.** Proposal lifecycle is always a diamond. Neutral context events are gray. Harm is warm-toned with a unique shape | No shape carries two meanings |
| D-36 | Automation cells (V-09) | **v2** (DVA vs DD): an icon plus text in each cell: `check` "6", `x` "1 failed", `minus` "no run". Not a fill level | Text survives forced colors and needs no legend |
| D-37 | Pixel tolerance | **v2** (DD SF-1 vs SA ratio 0.002): `maxDiffPixels: 0`, `threshold: 0.1`, in the pinned Playwright image. If the flake budget (§8.7) is exceeded, the region is masked | A 0.2% ratio hides a moved button. Pinned images are deterministic |
| D-38 | Fonts in baselines | **v2** (DD SF-2 asked for Inter): use the pinned image's fonts as they are. Add a **manual macOS and Windows spot check** by the owner at R3 for Overview and Proposals | No binary font or apt step in CI. Real typography is judged on real OSes |
| D-39 | Reference screens | **v2** (DD MF-9 vs SA MF-20): **both.** R1 per surface is a cheap spec comment with an ASCII wireframe. **P2-11** builds four owner-approved reference screens once, and they become the conformance target for R2/R3 | One fixed target stops drift without writing every page twice |
| D-40 | Accent | **v2** (DD MF-6): the accent moves to indigo, `light-dark(#4338b0, #a5adff)`. It must differ from `--s1` by OKLab ΔE ≥ 0.08 (measured: 0.112 / 0.169) | Clickable and data must not share a colour |
| D-41 | Builders | **v2** (SA MF-12): a builder lands with its first consumer and a gallery entry. P2-5a extracts the existing builders (0 diff). P2-5c adds the core controls, adopted at once on existing pages | AGENTS.md bans abstractions with no consumer |
| D-42 | Plan location | **v2** (SA MF-16): this file lives at `docs/design/ui-overhaul/plan.md`, with the brief template and reviewer prompts beside it (P0-0) | Child sessions start from a clean checkout |
| D-43 | G3 values | **v2:** `review.decidedBy?: 'triage' \| 'human'` via an option on `akmProposalAccept`/`akmProposalReject`; `drain.ts` passes `'triage'`. A `'human-drain'` value is deferred (Q-12) | The drain cannot reliably tell who invoked it |
| D-44 | Shape of surfaces | **v2** (DD MF-3, SF-8): cards and tiles `--radius-md` (8px), controls `--radius-sm`, dialogs `--radius-lg`. **Cards never nest. No shadow on cards** | One calm surface family |
| D-45 | When R2 is required | **v2** (DD SF-12): required when the pixel diff is non-empty or `src/assets/ui/**` changed. Server-only PRs with 0 diff get DV only if a metric changed | Reviewer bandwidth |
| D-46 | V-03 content | **v2** (DVA MF-06): two lines, never summed: improve runs (excluding dry runs) and tasks. `active` older than 6 h = "did not finish" | A scheduled improve writes both rows. `active` can mean crashed |
| D-47 | Hollow and outline marks | **v2** (DVA MF-03): one treatment per meaning (§5.0 R2). Rate charts do not plot the in-progress period | A Monday-morning partial week reads as a sudden change |
| D-48 | Text in marks | **v2** (DVA MF-17): no text inside data marks. Labels go outside, in `--text`/`--muted` | Several fills fail 4.5:1 with either ink |
| D-49 | Rubric | **v2** (DD MF-8): anchored 1/3/5 levels with one objective check per dimension. R3: mean ≥ 4.0, no dimension < 3.5. R4: mean ≥ 4.2, no dimension < 4.0. The separate Nielsen re-score is dropped | One rubric, comparable across agents |
| D-50 | Review rounds | **v2** (DD §11.5): at most **3 review rounds per PR**. After that the PR is split, or the conflict escalates (§11.5.1) | Prevents endless loops and moving goalposts |
| D-51 | Screen readers | **v2** (SA MF-5): agents produce aria snapshots and keyboard traces. A human screen-reader pass is done by the owner (or a delegate, Q-10) at R3 Proposals, R3 Improve and R4 | Agents cannot run a screen reader |
| D-52 | Budgets | **v2** (SA MF-8): authored JS+CSS ≤ 85 KB gzip-9 (today 51.9). CSS ≤ 12 KB. A page module ≤ 8 KB. ECharts ≤ 200 KB. Timing medians of 5; fail at 2× | Today's measured numbers |
| D-53 | Browser floor | **v2** (SA MF-11): Chrome/Edge 123, Firefox 121, Safari 17.5. A boot check shows a plain notice on older browsers | `:has()` needs Firefox 121; `light-dark()` needs 123/120/17.5 |
| D-54 | Metric home | **v2** (SA MF-19): shared statistics live in `commands/metrics/stats.ts`. UI-only derivations live in `commands/ui/derive.ts`. A parity test keeps the UI and the CLI equal | B-04 was a UI number disagreeing with the CLI |
| D-55 | Search unit | **v2** (DVA MF-02, §6 corrections): M-01/M-02 count **explicit `akm search` calls** (curates do not write search rows), with repeats of the same normalized query from the same source within 10 minutes merged | Hook and agent loops are not independent trials |

---

## 1. Goals, non-goals and principles

### 1.1 Premise

akm ui is a local, single-user window onto **one person's akm environment over calendar time (UTC)**, and onto **what the improve processes have done in that environment over time**.

- akm builds, versions, releases, eval results and ledgers are **not** subjects. There is no version axis anywhere.
- The UI answers two questions:
  1. Is my environment getting better or worse, and where should I look?
  2. What has improve done for me, and has any of it hurt?

### 1.2 Goals

1. **Overview becomes a launchpad.** Attention first; every number links to its list. The morning check drops from 6 clicks to 1–2.
2. **Review is keyboard-first and reversible.** That means a split view, a "why" block, one-action accept with Undo, Revert and Reopen in the UI, and batch reject.
3. **An honest Improve impact page.** It shows Recorded and Classified outcomes, Linked usage, and a separate harm log, with no causal number (D-01).
4. **Every misleading number is fixed before any new number is added** (§9).
5. **Professional-grade code and UI.** Modern CSS, clean code and one design system, enforced by lint, tests, visual regression and design review (§8.8).
6. **WCAG 2.2 AA on every route,** in light, dark and forced-colors.

### 1.3 Non-goals

- Version, release or build comparisons; importing eval results or ledgers.
- Composite scores, ROI, money, "tokens saved". Netting harm against gain.
- Before and after on `utility_scores`/`outcome_score`.
- Causal effect estimates in v1.
- Real-time or auto-refresh.
- Multi-user features.
- A front-end, CSS or component framework.
- Config writes (D-19), a density toggle (D-18), the ⌘K palette (D-20), chart keyboard stepping (D-28), "since your last visit" (D-33).
- Empty-state illustrations: empty states use text, an icon and an action only.

### 1.4 Principles

**Product**
1. **Jobs before stores.** Pages are organised by what the user does, not by where the data lives.
2. **Attention first:** failing and waiting things come first, and every row carries a verb.
3. **Confirm only the irreversible.** Everything else is undoable.

**Data honesty**
4. **Rates over counts, with n.** Below the minimum sample, show counts and draw no line.
5. **Attribution words:** use "proposed, accepted, changed after, moved more than". Never "improved, caused, boosted, saved".
6. **Harm is separate from gain** and never netted.
7. **One window per visual region,** stated as visible text (the window chip, §7.5).

**System and code**
8. **One way to do each thing:** one escaping path, one builder per component, one chart wiring, one token per value, one shape per meaning.
9. **Progressive enhancement:** the data table is the source of truth. Charts and tooltips only enhance it.
10. **Professional-grade code and UI is a requirement, not a goal.** Every PR follows the modern-CSS and clean-code checklist (§8.8) and the anchored design rubric (§11.3).

### 1.5 Quality bar ("done")

**Code**
- `bun run check` is green.
- The `ui-visual` job is green, with zero unexplained pixel diffs.
- axe reports 0 violations beyond the shrinking ratchet, which must be empty by P5-9.
- The CSS lint and source scans report 0 findings.
- The budgets in §8.5 are met.
- The UI and the CLI agree on every shared metric (parity test).

**Design**
- Every page passes **R3**: mean ≥ 4.0 across rubric dimensions, no dimension < 3.5, owner approval.
- The product passes **R4**: mean ≥ 4.2, no dimension < 4.0, owner approval.
- Every state is designed: loading, empty, low-data, error, partial error and success.
- Every page conforms to its reference screen (P2-11), or each divergence is explained.

---

## 2. User jobs and target workflows

**Counting rules:** a click is one pointer action and a key is one keypress. A switch is a page change. A scroll is counted when the target is below the 900px fold.

| Job | Current | Current cost | Target | Target cost | Tasks |
|---|---|---|---|---|---|
| **J1 Morning check:** healthy? what did improve do? | Read PASS (it hides unknowns) → scroll 2 screens → expand "Recent improve runs" → scroll to health → expand groups → Proposals → Recent → Changes | **6 clicks, 3 switches, 3 long scrolls** | Overview. Status strip "Healthy · 4 checks could not run". **Needs attention** ≤ 5 rows with verbs. Pulse band plus the improve line → click one row | **1–2 clicks, 0–1 switches, no scroll** | P3-2, P5-2 |
| **J2 Review a pending proposal** | Nav → scroll past the chart → ref → diff with no "why" → scroll → Accept → Confirm → Next | **Accept 5 clicks** (4 from the second on). **Reject 3 clicks + typing.** No keys | Split view at `wide`. Sticky action bar, "Why akm proposed this" above the diff | **Accept 1 key** (`a`) when revertable, else 2 (`a`, `Enter`). **Reject `r` + a reason chip + `Enter`.** 0 switches | P1-10, P3-4, P3-5, P3-6 |
| **J3 Undo or revert** | CLI only. Impossible for creates | CLI | Undo in the status bar (1 action or `u`). Later: Recent → Revert → Confirm | **1 action / 3 clicks** | P3-6 |
| **J4 Batch triage** | Select → Accept selected → Confirm. No batch reject | N + 2, accept only | `x` selects. The selection bar has Accept selected / Reject selected… with one reason | N keys + 2 | P3-6 |
| **J5 Find and fix an asset** | Ctrl+K → type → result → a command shows "no body" (B-01) → edit only knowledge/memory → generic feedback form | 3–5 clicks, dead ends | Ctrl+K → result. Rail with "1 pending proposal → Review". Edit, or Suggest a fix; Helpful / Not helpful | **2–3 actions in place** | P1-1, P3-8, P5-8 |
| **J6 Understand a search miss** | Overview → scroll → expand → day button → copy → Search → paste | 5 clicks, 2 switches, copy and paste | Needs attention "3 queries found nothing on 2+ days → See misses" → Misses tab → Search again / Create knowledge | **2 clicks, 1 page** | P3-7, P4-6, P5-7 |
| **J7 What has improve done over weeks?** | Not answerable | — | Improve line on Overview → Improve impact | **1 click** | P5-4…P5-6 |
| **J8 Did my improve runs and scheduled tasks finish?** | Expand "latest 10, all time" on a misleading axis | 1 click + scroll | Pulse "Runs finishing: improve 6 of 6, tasks 7 of 8" → Automation card | **1 click** | P5-2, P5-3 |
| **J9 First open of a new install** | Each page names a different CLI command; PASS shows over empty charts | unclear | "Set up" rows in Needs attention, each with a copyable command. Charts with < 3 bins show a stat | 0 clicks to understand | P3-2 |

**Review keyboard map** (Proposals list and detail only)

- Shortcuts never fire inside text fields.
- They can be turned off in the help dialog; the choice persists.
- `kbd` hints on buttons appear after the first keyboard interaction.
- This satisfies WCAG 2.1.4.

| Key | Action |
|---|---|
| `j` / `k` | next / previous proposal |
| `o` / `Enter` | open the focused row |
| `x` | toggle selection |
| `a` | accept: immediate if revertable, else opens the inline confirm (`Enter` confirms) |
| `r` | reject: opens the reason chips and focuses the first |
| `u` | undo the last decision while the status bar shows it |
| `n` | next pending |
| `]` / `[` | next / previous change in the diff |
| `Esc` | cancel the confirm or reject step and refocus its opener; close the dialog; hide a tooltip |
| `?` | shortcut help (`<dialog>`) |

---

## 3. Information architecture and navigation

### 3.1 Sidebar (D-05)

```
akm ui                         → #/overview
  Overview
  Search
REVIEW
  Proposals            12       count badge, name "Proposals, 12 waiting"; hidden at 0
  Improve impact
  History
SETUP
  Bundles & index
  Config
──────────
  akm 0.10.x · host            [data-volatile]; version shown only here
  Theme  (System | Light | Dark)
```

- Section headers are `--text-xs`, 600, uppercase, `letter-spacing: .06em`, `--muted`. This is the only tracking in the system.
- The **sidebar contains no buttons** except the mobile menu toggle and the theme control. "Reload data" lives in each page header with "Updated 2 min ago".
- **Highlighting:** Asset, Edit and New highlight Search. Proposal detail highlights Proposals.
- **Skip link** "Skip to content" is the first focusable element.
- **Under the `50rem` shell breakpoint:** the menu is an APG disclosure. Esc closes it and returns focus to the toggle.

### 3.2 Routes and redirects

| Route | Page | Purpose | Redirected from |
|---|---|---|---|
| `#/overview?window=30d\|90d` | Overview | What needs me now; how my environment compares with my usual; recent trends | `window=24h\|7d` → `30d` |
| `#/search?q=&tab=results\|browse\|misses&…` | Search | Find an asset; see what akm could not find | — |
| `#/proposals?status=pending\|recent&source=&age=` | Proposals | Triage proposals: decide, undo, revert | — |
| `#/proposals/<id>` | Proposal detail (split-view pane) | Decide one proposal with its reason and diff | — |
| `#/improve?since=90d\|all&bundle=` | Improve impact | What improve proposed, changed and cost over weeks, and what went wrong | — |
| `#/history?origin=&q=` | History | Commits to the bundle's git, and what made them | `#/changes` |
| `#/asset/<ref>?section=&history=1` | Asset | Read, fix and give feedback; see improve history | `#/asset?ref=` |
| `#/edit/<ref>` | Edit Markdown | Edit a knowledge or memory asset | `#/edit?ref=` |
| `#/new?name=&q=` | New knowledge | Create a note, prefilled from a miss | — |
| `#/bundles` | Bundles & index | Sources, write target, index status | — |
| `#/config` | Config (read-only) | Effective configuration and the source of each value | — |

- **Titles:** `<specific> · <page> · akm ui`, e.g. "stash//lessons/rg · Proposal · akm ui".
- **Reachability:** no page is reachable only through a chart. Every chart drill-down is also a table button.

---

## 4. Page-by-page target design

**Shared frame on every page**
- A breadcrumb where the page has a parent (`<nav aria-label="Breadcrumb">`).
- A page header: `<h1 tabindex="-1">` (`--text-2xl`), a subtitle (`--space-1` below it), and at the inline end "Updated 2 min ago · Reload data".
- Sections, each with an `<h2>` (`--text-lg`) and a **window chip** at its inline end (§7.5).

**Shared states**
- Every async region renders exactly one of: skeleton, content, empty, low-data, or a section error with "Try again".
- A partial API failure is **one** `notice` row with an `alert-circle` icon, placed directly under the page header. It lists the failed sections and is never repeated per section.
- No state may shift the layout relative to success: skeletons are drawn at final size, and CLS ≤ 0.05.

### 4.1 Overview

**Order** (D-27):
1. Header. Subtitle: "Your akm environment. Times are UTC."
2. **Status strip.** A 16px status icon plus the word: "Healthy", "1 failing", "Warnings" or "Health unavailable", followed by "· 4 checks could not run". Only the word is coloured. Then the counts as links (failing · warning · could not run · passing) and the chip "Last 24 hours". It is a 2×2 grid at `narrow`.
3. **Needs attention.** At most 5 rows (then "+2 more"), ordered by severity, then age. Each row is an icon, a sentence and a verb link.
   | Row | Source | Verb |
   |---|---|---|
   | "1 health check is failing: <name>" | `/api/overview` health | View → health group, opened |
   | "12 proposals waiting, oldest 9 days" | `/api/overview/pulse` `attention.pending` (stash-scoped, unwindowed) | Review |
   | "2 runs failed or did not finish this week" | improve runs and tasks, 7 days (V-03 rules) | View runs |
   | "3 queries found nothing on 2 or more days" | `attention.misses` (P4-6 via P4-2) | See misses |
   | "1 change was reverted this week" / "1 flag after a change" | harm items in 7 days | View → `#/improve#harm` |
   | "Set up: connect a model so improve can run" (D-24) | `connections-and-harnesses` check | Copy `akm setup` |
   - Empty: "Nothing needs you. Last improve run 02:10 UTC finished ok." Or "No improve runs recorded yet."
4. **"Last 7 days against your usual"**, with the chip "Last 7 days vs the 8 weeks before".
   - 3 pulse tiles (V-01–V-03).
   - Their footer line is the **improve line** (V-04), with the chip "Last 4 weeks".
5. **"Trends"**, with the window chip "Last 30 days".
   - The segmented control **30d · 90d** sits at the inline end of the `h2` from P5-3 on (D-30).
   - The date range line reads "1 Oct 00:00 – 31 Oct 14:20 UTC (today is partial)".
   - Cards at `wide`:
     - **Retrieval health** spans both columns (V-05, V-06);
     - **Feedback and use** | **Model calls**, side by side (V-07, V-08);
     - **Automation** spans both columns (V-09).
   - Each card's `h2` carries a total line, e.g. "212 searches · 13 found nothing".
6. **Measurement coverage** (`disclosure`, closed): result-count coverage (M-03), token coverage (M-23), "selects: all sources", and the data-start dates per store.
7. **Health checks.** Failing and Warnings are open. Could-not-run and Passing are closed.

**Wireframe at 1440×900, light** (glyphs stand for SVG icons, §7.6):
```
┌──────────────┬──────────────────────────────────────────────────────────────────┐
│ akm ui       │ Overview                                Updated 2 min ago  Reload │
│ Overview  ◂  │ Your akm environment. Times are UTC.                              │ doclint:ignore
│ Search       │ ✓ Healthy · 4 checks could not run  0 failing · 0 warning · 4 · 10│
│ REVIEW       │                                                 [Last 24 hours]   │
│ Proposals 12 │ Needs attention                                                   │
│ Improve      │ ⚠ 12 proposals waiting, oldest 9 days                    Review → │
│ History      │ ⚠ 3 queries found nothing on 2 or more days          See misses → │
│ SETUP        │ ⓘ 1 change was reverted this week                          View → │
│ Bundles      │ Last 7 days against your usual          [Last 7 days vs 8 weeks]  │
│ Config       │ ┌ Found nothing ────┐ ┌ Negative feedback ┐ ┌ Runs finishing ───┐ │
│              │ │ 6.1%              │ │ 3 negative, 2     │ │ Improve 6 of 6 ok │ │
│              │ │ – within your     │ │ assets (too few   │ │ Tasks   7 of 8 ok │ │
│              │ │   usual 2–11%     │ │ for a usual range)│ │ 1 failed: nightly │ │
│              │ │ ┄╱╲_╱‾╲_┄ band    │ │ Latest: …/rg, Tue │ │ -index, Tue 02:10 │ │
│              │ └───────────────────┘ └───────────────────┘ └───────────────────┘ │
│              │ Last 4 weeks: improve proposed 31; 20 accepted (2 since reverted),│
│              │ 9 rejected (7 by you), 2 waiting · 455 calls  Improve impact →    │
├──────────────┼──────────────────────────── 900px fold ───────────────────────────┤
│              │ Trends                                  [Last 30 days] (30d|90d)  │
│              │ ┌ Is search finding what you need?  212 searches · 13 found nothing┐│
│              │ │ takeaway …                              Recorded · Last 12 weeks ││
│              │ │ [ rate p-chart, 12 weeks ...................... 12.5rem ]        ││
│              │ │ [ event strip on the same weeks ............... 2.5rem  ]        ││
│              │ │ [ searches columns, charts window ............. 7.5rem  ]        ││
│              │ │ [ search time p50/p90, charts window .......... 7.5rem  ]        ││
│              │ │ ▸ Data and details                                               ││
│              │ └──────────────────────────────────────────────────────────────────┘│
│              │ ┌ Feedback and use · 21 rated ┐ ┌ Model calls · 455 · tokens 91% ┐ │
│              │ └─────────────────────────────┘ └────────────────────────────────┘ │
│              │ ┌ Automation · 14 runs, 1 failed ──────────────────────────────────┐│
│              │ ▸ Measurement coverage                                            │
│ akm 0.10.x   │ Health checks  ▾ Failing (0) ▾ Warnings (0) ▸ Could not run (4) … │
│ Theme ◐      │                                                                   │
└──────────────┴───────────────────────────────────────────────────────────────────┘
```

**Mobile (390):** header → strip (2×2) → Needs attention (each verb on its own line at the inline end) → pulse tiles stacked full width, with sparks → improve line → Trends (with the control at full width; it never wraps mid-control) → cards in one column → health.

**States**

| State | Treatment |
|---|---|
| Loading | Strip, 3 attention rows, 3 tiles and the cards as skeletons at final size. The pulse (its own route) renders first |
| Empty install | "Set up" rows. Tiles: "No searches recorded yet." Cards: one row, e.g. "No searches in the last 30 days. Searches from you and your agents appear here." |
| Low data | Tiles show the low-data copy (§5.0 R3). A card with < 3 non-empty bins shows a stat and a sentence |
| Error | `sectionError` per region. Whole route: `errorState` with the code, focused |

**Removed:** the Metrics details tiles (B-06, B-07), the accept-rate table (D-17), the improve-run scatter (B-14), the Activity chart (D-31) and the volume tiles (D-27).

### 4.2 Improve impact (`improve.js`, new)

- **Header:** "Improve impact". Subtitle: "What akm's improve processes did in your environment. Times are UTC."
- **Toolbar:** a segmented window control, **90d** · All (D-25); a Bundle select (Q-14); "How to read this page" (§7.5, the only explainer on any page).
- **Summary line**, counts only:
  > "Last 90 days: 58 kept · 3 reverted · 2 flags after a change · 412k tokens (91% of calls reported)"
  - Each count links to its section.
  - When the harm count is above 0, its fragment is styled `warn` with an icon (DD SF-6). Sections are never reordered dynamically.
- **On this page** (at `wide`): a sticky `<nav aria-label="On this page">`, 12rem wide, at the inline start. `aria-current="location"` follows the section in view. It shows the harm count. Below `wide` it becomes a jump `<select>` under the summary line.
- **Sections**, which lazy-load on intersection from one `/api/improve/impact` response:
  1. Outcomes by process (V-10)
  2. Review flow (V-11)
  3. Library change (V-12)
  4. Harm log `#harm` (V-13), never collapsed
  5. Cost (V-14)
  6. Changed assets (V-15)
  7. Judge and you (V-17), as a table
- **Drill-down:** table buttons (and marks, for the pointer) open a `detailPanel`. It sits beside the card at `wide`, and below it otherwise. Content comes from `/api/proposals?week=&source=&class=`.

**Wireframe (`wide`):**
```
Improve impact                                          (90d● | All)  Bundle: All ▾
What akm's improve processes did in your environment. Times are UTC.  ▸ How to read this page
Last 90 days: 58 kept · 3 reverted · ⚠ 2 flags after a change · 412k tokens (91%)
┌ On this page ┐ ┌ Who decided what, week by week?            Recorded+Classified · 90 days┐
│ Outcomes     │ │ reflect   [weekly stacked columns ……]  Of 58 created: 41 accepted…     │
│ Review flow  │ │ distill   [ ……………………………………… ]  …                                  │
│ Library      │ │ ▸ your own proposals (folded)                                         │
│ Harm log (2) │ ├────────────────────────────────────────────────────────────────────────┤
│ Cost         │ │ Is review keeping up?   [waiting-for-you step line]  This week: 12 …   │
│ Changed      │ │ …                                                                      │
│ Judge and you│ └────────────────────────────────────────────────────────────────────────┘
└──────────────┘
```

**States**

| State | Treatment |
|---|---|
| Never run | "Improve has not run in this environment yet. It runs with `akm improve` or on a schedule." Copy button and a guide link |
| Process with no rows | Hidden, with the note "No proposals from extract in the last 90 days." |
| Low data | Counts instead of rates. A row with < 3 non-empty weeks becomes a one-line summary |
| Harm empty | "No reverts, reopened rejections or risky retirements, and no flags after a change, in the last 90 days. Checked 40 changes." |
| Autonomy off | Memory rows read "Off. Turn on with `experimental.improveAutonomy`." (Q-15) |
| Error | A per-section error, isolated by `section()` (`commands/ui/api.ts:112-120`) |

### 4.3 Proposals review

**At `wide`** (the 1440 and 1280 page containers both qualify, D-27b):
- A list, 20rem wide, plus a detail pane.
- In the detail pane, the diff defaults to **Inline** when the pane's own container is < 56rem. Side by side is offered only at ≥ 56rem.

**At narrow and medium**, the list and detail are stacked pages. The list is a **plain divided list**, not cards.

**Wireframe (`wide`, 1440):**
```
Proposals                                                 Updated 1 min ago  Reload
12 waiting: 3 under 1 day, 6 within a week, 3 older              ▸ By source and age
[ Pending 12 | Recent ]       Source: (All) (reflect 7) (distill 3) (extract 2)
┌ list 20rem ────────────────┐┌ detail ───────────────────────────────────────────┐
│ REFLECT · 7  ☐ Select all 7 ││ Proposals / reflect / stash//lessons/rg           │
│▌stash//lessons/rg     2d   ││┌ sticky bar ───────────────────────────────────────┐│
│  conf 0.82                 │││ stash//lessons/rg [reflect] [pending]             ││
│ stash//commands/deploy 9d  │││        ‹K  J›   [Reject  R]   [Accept  A]         ││
│ DISTILL · 3                ││└───────────────────────────────────────────────────┘│
│ …                          ││ Why akm proposed this                              │ doclint:ignore
│                            ││   Process      reflect · feedback lane             │
│                            ││   Triggered by "rg flags are wrong on macOS" (3 Oct)│
│                            ││   Judge        passed: "fixes the flag order…"     │
│                            ││   Confidence   0.82                                │
│                            ││ Change  2 added, 1 removed in 2 hunks  ‹[ ]›  Inline│
│                            ││ ┌ diff ────────────────────────────────────────────┐│
│                            ││ ▸ Proposal details                                 │
│                            ││┌ status bar (after a decision, shadow-2) ─────────┐ │
│                            │││ ✓ Accepted · committed 1a2b3c4  [Undo u] [Next n]│ │
└────────────────────────────┘└────────────────────────────────────────────────────┘
3 of 12 reviewed this session
```

**Rules**
- **Action bar.** The primary action sits at the inline end: ‹K J› · Reject · **Accept**. In the no-op state the same slot becomes "**Reject as no-op**" (B-15). The selected row has a 3px `--accent` inline-start bar and `aria-current`.
- **One sticky bar at a time.** When ≥ 1 row is selected, the selection bar ("3 selected · Accept selected · Reject selected…") replaces the action bar in the same slot.
- **Status bar.** It docks to the bottom of the detail pane. The pane gets `padding-block-end` equal to its height while it shows. `scroll-padding-block-start` equals the sticky bar height (WCAG 2.4.11).
- **"Why akm proposed this"** has at most 6 fields and is always visible: process and lane (`eligibilitySource`); the triggering feedback (quoted, linked); judge outcome and reason; confidence; validation findings; and the retirement card for retirements.
- **Diff.** Inline/Side toggle. The pressed state is a check icon plus an inset border. A summary "2 added, 1 removed in 2 hunks" with `[`/`]`. sr-only "Added:"/"Removed:". Word marks are `<mark>` with an underline (B-58, B-62).
- **Queue summary (D-13).** One sentence plus the table "By source and age": each row has an inline-SVG age bar (`--age-1..3`, `--age-unknown`, "older is stronger") with the counts as text links.

**Decision flows** (D-06, D-07)

- **Accept, revertable.**
  - The button keeps focus, gets `aria-disabled="true"` and reads "Accepting…".
  - On success, the status bar shows "Accepted · committed 1a2b3c4 · Undo · Next pending", and focus moves to Next pending.
  - Undo calls `POST /api/proposals/:id/revert`. The bar then reads "Reverted · restored from backup".
- **Accept, not revertable (create).** The inline confirm reads "Accept and create knowledge/foo.md? This cannot be undone from the UI." Enter confirms; Esc cancels and refocuses.
- **Reject.**
  - `r` opens the reason chips (`role="radiogroup"`): Wrong · Stale · Duplicate · Style · Other. "Other" requires text.
  - The textarea has `aria-describedby` → hint and error, `aria-invalid` on error, and an "Error:" sr prefix.
  - A live count is announced within 10% of the 2,000-character limit (`MAX_REJECT_REASON`, `commands/ui/proposal-actions.ts:28`).
  - After rejecting, the status bar reads "Rejected · Reopen · Next pending". Reopen calls `/reopen`.
- **Batch.**
  - Checkboxes sit in ≥ 24px labels. Select-all is named "Select all 2 reflect proposals".
  - The selection region (`role="region" aria-label="Selection"`) announces its count politely.
  - Batch reject shares one reason. Per-id results are listed. **There is no Undo for a batch** (D-06); the results link to Recent.
- **Recent.**
  - Times are shown absolute and relative.
  - Decider badges: judge · you · procedural · decider unknown. These are Classified until G3.
  - Rejections use a neutral badge.
  - Inline Revert (revertable accepted rows) and Reopen (rejected rows) each have an inline confirm.
- **Errors** say what happened, why, and what to do, and keep the code:
  - `PROPOSAL_STALE`: "The asset changed after this proposal was made. Reject it as stale, or run `akm improve` again."
  - `ASSET_MUTATION_LEASE_HELD`: "Another akm process is writing this asset." + **Try again**.
  - `PROPOSAL_NOT_REVERTABLE`: "This change has no backup to restore. Edit the asset to undo it."

**States**

| State | Treatment |
|---|---|
| Empty pending | "Nothing waiting for review. Improve's next proposals will appear here." + "See recent decisions" + "How this queue has changed → Improve impact" |
| Detail not found | "This proposal no longer exists. It may have been decided elsewhere." + Back to queue |
| Busy | `aria-busy` on the pane. Buttons are `aria-disabled` |

### 4.4 History (`history.js`, renamed from `changes.js`)

- **Header:** "History", with the subtitle "Commits in <bundle> (`~/…/bundle`)", using `pathText`.
- **Toolbar:** origin chips (All · improve · accepted · remember · manual), a text filter, a bundle select.
- **Timeline:** day headings "Sat 1 Nov 2026 (UTC)", grouped by UTC date (B-34). Each row shows time, subject, sha, an origin badge (verb "accepted") and files.
- **Proposal link:** a row links to its proposal when its subject names a ref that matches an accepted proposal within ±5 min **[uncertain; commit messages carry a ref, not an id, `commands/proposal/repository.ts:2256`; otherwise no link]**.

**States**

| State | Treatment |
|---|---|
| Not a git repo | "This bundle is not a git repository, so history and revert-by-commit are unavailable." + a copyable `git init` and a docs link |
| Empty | "No commits yet." |

### 4.5 Search: Results · Browse · Misses

- **Header:** "Search", with a secondary button **New knowledge** (D-05).
- **Form:** `role="search"`. Enter submits; there is no Search button. A `disclosure` "Filters" holds Type, Bundle, State and Results, each a `field` with a visible label. State's hint: "current, historical, or all versions of facts".
- **Tabs** (APG):
  - **Results.** The count is announced in `#route-status`: "12 results for "deploy", keyword mode". Matched terms are highlighted with `<mark>`. Below each result: "Matched in: title, description · rank 3". The score moves to "Ranking details".
  - **Browse.** Groups, with `overflow-wrap:anywhere` on the summary (B-23).
  - **Misses** (`/api/search/misses`). Two groups: "Repeat (2+ days)" first, then "Recent". Columns: query, days, last seen, Search again, Create knowledge. Note: "Queries come from you and your agents. Credentials are redacted before storage."
- **Empty result:** "No assets match "rollback database migration"." Actions: **Create knowledge for this query** (primary) · Search all states · Clear filters.
- **Misses empty:** "No searches came back empty in the last 30 days."

### 4.6 Asset

**Wireframe (`wide`):**
```
Search results / stash//lessons/rg
rg flag ordering on macOS                                         [Edit] (primary)
[knowledge] [stash]  stash//lessons/rg [copy]        [Helpful] [Not helpful]
┌ body (72ch) ───────────────────────────────┐ ┌ rail 18rem ──────────────────┐
│ …                                          │ │ Type        knowledge        │
│                                            │ │ Bundle      stash            │
│                                            │ │ Updated     3 Oct (29d ago)  │
│                                            │ │ Feedback    +4 / −1 (90 d)   │
│                                            │ │ ⚠ 1 pending proposal Review →│
│                                            │ │ Improve history (V-18)       │
│ ▸ Asset details ▸ Markdown source ▸ History│ └──────────────────────────────┘
```

- **Rail placement.** At `medium` and below, the rail stacks above the body as a summary list.
- **Body.** The first non-empty of `content` and `template` (B-01). A leading `# Title` equal to the H1 is dropped (B-41). Code blocks are `role="region" tabindex="0" aria-label="Code block, N lines"` (B-40).
- **Actions.**
  - **Edit** (knowledge, memory).
  - **Suggest a fix** (other types): an inline "Replace … with …" form. It posts the `feedback` action with `replace[]`/`with[]`. There are ≤ 10 equal-length pairs, passed as `--replace=`/`--with=` argv, and the existing `/api/feedback` does not accept them today (`commands/ui/workspace-actions.ts:231-241`).
  - **Helpful / Not helpful** are secondary sm buttons with `thumb-up`/`thumb-down` icons; each expands the feedback form.
  - **Copy ref.**
- **States:**
  - Not found: "No asset named <ref>. It may have been renamed or retired." + Search.
  - Redacted: the existing notice.

### 4.7 Bundles & index

- **Header:** "Bundles & index", with the subtitle "Where akm reads assets from and where new ones are written."
- **Working stash** card first (Q-19), with a "default" badge and its path. Then the configured bundles.
- **No extra bundles:** "No other bundles. Add one below or with `akm bundle add <source>`." Never mention `akm init` (B-02).
- **Defaults form:**
  - "Default bundle for reads" and "Where new assets are written".
  - The "Use fallback" option is renamed "Automatic (working stash)" **[uncertain about the exact semantics; P1-1 confirms]**.
  - Save is secondary. The page's one primary is "Add bundle".
- **Card label:** "Allow writes to this bundle (default for its components)". Update shows "Working…", then "Updated 251 entries in 2.1 s".
- **Index card:** entries by type, last index time in UTC. Before the first index: "Index not built yet: run `akm index`".

### 4.8 Config (read-only)

- **Header:** "Effective config (read-only)", with the subtitle "Merged from defaults, your config file and extends. Change values with `akm config set`."
- **Summary list:** key, value, a source badge (default · file · extends · "source unknown", neutral), and a "How to change" disclosure with the template `akm config set <key> <value>`. Never the value itself, and never a redacted value.

### 4.9 Edit and New knowledge

- **Write | Preview** APG tabs (B-44).
- The status is announced on clean↔dirty transitions only (B-42).
- Ctrl/Cmd+S saves (B-43).
- The conflict heading takes focus.
- **Name hint:** "lowercase letters, digits and dashes; saved as knowledge/<name>.md". Errors are inline.
- **Load error:** "The index is out of date for this file." with "Rebuild index" (copy `akm index`) and "Open read-only" (B-74).
- **Unsaved guard:** a labelled region by the editor bar. Esc means "Keep editing" (B-30).
- `#/new?q=` prefills the title.

---

## 5. Visualization spec

### 5.0 Rules for every visual (normative)

**R1 Bins and coverage.**
- **Rate charts** use complete ISO weeks (Monday 00:00 UTC). **Count charts** follow the charts window: UTC days at 30d, ISO weeks at 90d. **Pulse tiles** use trailing 7-day blocks (R5).
- `dataStart = max(since, earliest kept row of the store feeding the chart)`, computed per store (`usage_events`, `events`, `improve_runs`, `llm_usage`). Never compute it as `now − 90 d`, because purges run only at `akm index` (`indexer/indexer.ts:1869`) or `akm improve` (`commands/improve/loop-stages.ts:738-755`).
- Every bin in [dataStart, until) is present. Counts are zero-filled only inside it. Rates and medians are null at n = 0.
- A bin where a required field (`resultCount`, `totalMs`) is missing on > 10% of rows is treated as below the minimum. Its row says "result count recorded for 61 of 90 searches".
- Signature: `zeroFill(bins, {since, until, dataStart, unit})`.

**R2 One treatment per meaning (D-47):**

| Condition | Rate chart | Count chart | Table row |
|---|---|---|---|
| Below the minimum (R3) | hollow circle (fill `--surface`, series stroke), no connecting segment either side | n/a | "n=12 (too few for a rate)" |
| In-progress period | **not plotted** | outline-only bar (2px series stroke) with the outside label "so far" | "(in progress, to 14:20 UTC)" |
| First bin starts mid-bin | plotted if it meets R3; x label "(partial)" | outline-only bar, label "partial" | "(partial: from 3 Aug)" |
| Partial token coverage (< 80%) | n/a | 45° hatch fill, always on (independent of D-04), label "partial" | "tokens for 40 of 95 calls" |
| Before data starts | no bin; a dashed vertical rule labelled "data starts 3 Aug" | same | omitted; the caption names the date |

The per-item hatch uses `itemStyle.decal`. Whether that renders while `aria.decal.show` is false is **[uncertain; P5-1b verifies. Fallback: an SVG pattern via a custom series, never an outline]**.

**R3 Minimum samples**

| Measure | Minimum |
|---|---|
| Searches | 30 per bin |
| Signed feedback | 10 per bin |
| Runs | 1 for counts; 5 for any rate |
| Decided proposals | 10 per window |
| Kept | 5 |
| Appearances (V-15 ratio) | 20 |

- Below the minimum, the summary says "3 weeks had too few searches to show a rate".
- Low-data copy: "Not enough searches this week to show a rate (12; a rate needs 30)."

**R4 Uncertainty**
- **Wilson 95%** intervals appear only in tables and on rates that are not p-charts (V-10 cohort, V-17, M-19): "73% (48–89%, n=15)".
- p-chart readouts never show Wilson (R5).

**R5 p-chart (D-02)**
- **Pulse blocks.** Block 0 is the last 7 complete UTC days before today 00:00 UTC; block 1 is the 7 days before that; and so on. The sparkline shows blocks 11…0 (84 days). The tile value is block 0. The in-progress day is never included.
- **Charts** use complete ISO weeks. The in-progress week is not plotted.
- **Centre.** One fixed p̄ = Σk/Σn over the 8 blocks or weeks *before the latest one*.
- **Limits** at each point's own n: lo = Q(0.00135; nᵢ, p̄)/nᵢ and hi = Q(0.99865; nᵢ, p̄)/nᵢ (exact binomial). They are drawn across the whole chart.
- **Laney.** σ_z is the mean moving range of the baseline z-scores ÷ 1.128. When σ_z > 1.5, the limits widen by σ_z, and the caption adds "Your weeks vary more than chance alone would explain, so the usual range is widened."
- **Signals** are evaluated only after the baseline: the latest point outside the limits, or 8 consecutive points on one side of p̄, counted back from the latest. Copy says "unusual for you", never "worse because".
- **The band** is drawn only when ≥ 4 of the 8 baseline points meet R3. Otherwise: "Building your usual range: 2 of 4 weeks so far. Until then, counts only."
- **Band drawing.** A `--band` fill (decorative) **plus 1px dashed edge lines in `--muted`**, plus a right-edge label "your usual range". In forced colors: `GrayText` dashed edges, no fill. The sparkline draws the edges only, as a 1px dash.
- **Readout copy:** "6% found nothing (13 of 212 searches). Your usual range at this volume: 2–11%. Within your usual range."
- **Signature:** `pChart(points, {baselineCount: 8, minBaseline: 4, minN, limits: 'binomial', laney: true})` → `{center, lo[], hi[], baselineRange:[i0,i1], sigmaZ, signal:'usual'|'higher'|'lower'|null}`.

**R6 Tier and window.** Each visual's caption third line reads "<Tier> · <window>", e.g. "Recorded · Last 12 weeks".

**R7 Colour**
- Series tokens are for data only, and colour follows the entity across panels.
- Outcome slots (V-10, V-17): judge-accept `--s1`, you-accept `--s3`, judge-reject `--s2`, you-reject `--s4`, procedural `--s6`.
- **No process colour map** (D-34). There are never more than 4 categorical hues at once. **Never place `--s2` and `--s5` in one chart.**
- **One colour map per page**, declared in the page's R1 spec and checked at R3:
  - **Overview:** found nothing `--s1`, found something and searches `--s6`, latency `--s1`.
  - **Improve:** the outcome slots (V-10, V-17); V-11 waiting `--s1`; V-12 added `--s1`, retired `--s2`, edits `--s6`; V-14 single hue `--s1`, failures `--fail`.
- Status tokens are used only for harm and failure, with a word and an icon.
- `--accent` never appears in a figure (D-40).

**R8 Shapes.** Use only the single §7.6 table.

**R9 Accessibility contract (D-28, D-29)**

Markup:
```html
<figure class="chart-card" data-chart-scope="key" aria-labelledby="q-key">
  <figcaption>
    <h2 id="q-key">Is search finding what you need, compared with your usual?</h2>
    <p class="takeaway" id="t-key">… generated sentence with numbers …</p>
    <p class="tier">Recorded · Last 12 weeks</p>
  </figcaption>
  <div class="chart" data-chart="key" role="img" aria-labelledby="q-key" aria-describedby="t-key"></div>
  <details class="disclosure"><summary>Data and details</summary> …table with caption… </details>
</figure>
```
- **The chart node.** No `tabindex`. `wireChart` sets the ECharts SVG to `aria-hidden="true"`. ECharts runs with `aria:{enabled:true, label:{enabled:false}, decal:{show:<media>}}`.
- **The table** is the source of truth. It has a `<caption>`, `th scope`, units in the headers and the same order as the visual. It holds every value a tooltip shows. **Every drill-down a mark opens is also a button in the table.**
- **The tooltip** is a pointer enhancement only (D-11, WCAG 1.4.13).
- **Targets:** marks ≥ 10px visible with a 24px hit layer. Count axes use `minInterval:1`. Category axes only. No dual y-axes. `animation:false`.
- **At `narrow`:** one column, chart ≥ 12.5rem, month-only labels. No page-level horizontal scroll.

**R10 Fewer than 3 non-empty bins:** a stat plus a sentence, no chart.

**R11 Never draw:** version axes, dual y-axes, pies, donuts or gauges, moving averages, weekend tints, vanity totals, text inside marks (D-48), a time axis (D-26).

**R12 Sub-chart stacks** (V-05):
- Use a fixed pixel `grid.left` gutter (`56`) across the sub-charts, not `containLabel`, so the axes align.
- Only the bottom chart of a shared-axis group shows x labels.
- Heights: rate `--chart-h-sm`, counts `--chart-h-xs`, strip `--strip-h`.

### 5.1 Overview visuals

#### V-01 "Found nothing" (pulse)

| Field | Spec |
|---|---|
| Question | Are your searches finding something, compared with your usual? |
| Metric | M-02 (explicit `akm search` calls; repeats merged per D-55), with M-01 as n |
| Source | `usage_events` summary rows: `event_type='search'`, `entry_ref IS NULL`, `source='user'` (`commands/metrics/metrics-cli.ts:60`), plus `metadata.resultCount` (`commands/read/search.ts:398-410`). Served by `/api/overview/pulse` (P4-2) |
| Form | A tile: visible label "Found nothing"; the value is the block-0 rate; a delta line; a 12-block SVG sparkline with the band edges (R5) |
| Delta | "Within your usual range (2–11%)", or `arrow-up` "Higher than usual: 14% vs usual 6% (30 of 214)". The tone is `--fail` only alongside the words. Polarity: up is worse |
| Accessible name | Comes from the content, starting with the visible label (WCAG 2.5.3). sr-only spans add "in the last 7 days", "searches" and "Open retrieval health". No `aria-label` |
| Low data | "Not enough searches this week to show a rate (12; a rate needs 30)." |
| Link | `#/overview#retrieval` |
| Tier · window | Recorded · Last 7 days vs the 8 weeks before |
| Caveat (glossary) | "`resultCount` includes registry hits, so a search that found something only in a registry counts as found." |
| Available | Today (P4-2) |

#### V-02 "Negative feedback" (pulse)

| Field | Spec |
|---|---|
| Question | Is feedback on your assets turning negative? |
| Metric | M-09 over `source='user'` signed rows. Repeats on the same (asset, UTC day, signal) count once |
| Source | `usage_events` feedback rows (`commands/metrics/collect.ts:295-310,356-409`; source from `AKM_EVENT_SOURCE`, `commands/feedback-cli.ts:214`) |
| Form | **When ≥ 4 of the 8 baseline blocks reach 10 signed:** as V-01. **Otherwise** there is no band and no sparkline, and the tile reads "3 negative in the last 7 days, on 2 assets (14 rated in the last 4 weeks, too few for a usual range)" |
| Delta | Always names the most recent negative: "Latest: stash//lessons/rg, 'outdated flag', Tue" |
| Link | `#/overview#feedback` (V-07) |
| Tier · window | Recorded · Last 7 days |
| Available | Today |

#### V-03 "Runs finishing" (pulse, D-46)

| Field | Spec |
|---|---|
| Question | Are your improve runs and scheduled tasks finishing? |
| Source | `improve_runs` excluding `dry_run=1` (`storage/repositories/improve-runs-repository.ts`). A terminated run is `ok=false` (`commands/improve/improve-result-file.ts:95-120`). Also `task_history.status` (`storage/repositories/task-history-repository.ts:155-158`) |
| Rules | Task `completed` = ok; `failed` = failed; `active` started > 6 h ago = **"did not finish"** (not ok, named in the delta); `active` < 6 h = running, excluded |
| Form | Two lines, **never summed**: "Improve 6 of 6 finished ok" / "Tasks 7 of 8 finished ok". The sparkline is 12 blocks of the not-ok count, as columns in `--fail`, plus "0" text when there are none |
| Delta | "1 failed: nightly-index, Tue 02:10 UTC" |
| Empty | "No improve runs or tasks recorded in 7 days. Missing runs do not prove a schedule ran." |
| Link | `#/overview#automation` |
| Tier · window | Recorded · Last 7 days |
| Available | Today |

#### V-04 Improve line (text)

- **Copy:** "Last 4 weeks: improve proposed 31 changes. 20 accepted (2 since reverted), 9 rejected (7 by you, 2 by the judge), 2 still waiting. Model calls: 455; tokens reported for 412k (91% of calls). → Improve impact"
- **Shape:** `improveSentence:{window:'28d', proposed, accepted, acceptedThenReverted, rejectedByYou, rejectedByJudge, procedural, pending, decidedUnknown, calls, usageCalls, tokens}`.
- **Invariant**, tested: `accepted + rejectedByYou + rejectedByJudge + procedural + pending + decidedUnknown === proposed`.
- The line never uses the word "kept" (D-16).
- **Tier · window:** Recorded + Classified · Last 4 weeks.
- **Available:** today.

#### V-05 Retrieval health (card, spans both columns at `wide`)

| Field | Spec |
|---|---|
| Question | Is search finding what you need, compared with your usual? |
| Metrics | M-02 (a), M-01 (b), M-04 (c) |
| Source | `retrievalSeries` (`commands/ui/metrics.ts:10-45`), rebuilt with R1 bins (P1-5, P4-1) |
| Form | **(a)** No-result rate, the last 12 complete ISO weeks, whatever the charts window: a p-chart line `--s1` with band edges. **(V-06 strip)** directly below, on (a)'s weekly bins. **(b)** Searches: count columns following the charts window; the found-nothing segment is `--s1`, the rest `--s6`, with a 2px `--surface` gap. **(c)** Search time: weekly p50 (`--s1` solid) and p90 (`--s1` dashed), end-labelled, only for weeks with ≥ 20 timed searches; p95 only at ≥ 100. (b) and (c) share an x-axis |
| Card total | "212 searches · 13 found nothing" |
| Takeaway | (a): "Last week 6% of searches found nothing (13 of 212), within your usual range. 2 of 12 weeks had too few searches to show a rate." (b/c): "1,040 searches in 30 days, 61 found nothing. Typical search 140 ms; slow searches 610 ms (p90, 980 timed)." |
| Drill-down | Table buttons (and marks) open the no-result queries of that bin, each linked to `#/search?q=`, plus "See all misses". A mode filter (keyword · semantic · all) appears only when both modes occur |
| Table | bin, searches (after the merge, with "(241 before repeats merged)"), found nothing n and rate, result-count coverage, timed n, p50, p90, mode mix |
| Tier · window | Recorded · Last 12 weeks (a); Recorded · charts window (b, c) |
| Available | Today |

#### V-06 Environment event strip

| Field | Spec |
|---|---|
| Question | What happened in your environment around then? |
| Source | `improve_runs` (start, ok, excluding dry runs); `index_completed` with `mode='full'` (`indexer/indexer.ts:823-833`); retirement batches (≥ 3 accepted retire proposals in one UTC day). Config changes after G9 |
| Form | One row per event kind, on the host chart's category bins. Marks are snapped to their bin. Several of one kind in a bin show the mark plus a count ("2"). Shapes per §7.6 |
| Takeaway | "13 improve runs (1 failed), 1 full reindex, 2 retirement batches." |
| Table | a `<ul>`, or a table, of events by date with exact times |
| Tier | Correlated: timing only |
| Available | Today; config after G9 |

#### V-07 Feedback and use (card, D-31)

| Field | Spec |
|---|---|
| Question | What are your agents saying about your assets? |
| Form | No chart. **A "Recent negative feedback" table**: asset link, reason ≤ 280 chars, when (absolute and relative), source; newest first, capped at 20 with "Showing 20 of 41". Above it, one text line of counts for the charts window: "21 rated (18 helpful, 3 not) · 312 shows · 1,904 curates". Daily counts are in Data and details |
| Source | `feedback.recentNegative` (`commands/metrics/collect.ts:356-409`), usage counts |
| Tier · window | Recorded · charts window |
| Available | Today |

#### V-08 Model calls (card)

| Field | Spec |
|---|---|
| Question | What did model calls use? |
| Source | `llm_usage` (`commands/metrics/collect.ts:157-196`, `commands/metrics/types.ts:32-52`) |
| Form | Horizontal bars by process, **single hue `--s1`**, sorted by value, with direct value labels outside the bar. The Measure select (calls · tokens · model time) redraws in place and announces "Showing tokens". Coverage under 80% → hatch per R2 plus "partial: tokens for 40 of 95 calls" |
| Copy | "Not monetary cost." Empty: "No model calls in the last 30 days." |
| Tier · window | Recorded · charts window |
| Available | Today |

#### V-09 Automation (card, spans both columns)

| Field | Spec |
|---|---|
| Question | Did your scheduled runs run and finish? |
| Source | `task_history` (`commands/metrics/collect.ts:452-479`), `improve_runs` (`commands/ui/api.ts:148-186`); drill-down `/api/tasks/history` (`commands/ui/api.ts:442-476`) |
| Form | A weekly grid: one row per task plus one row for improve. Each cell is an icon plus text (D-36): `check` "6"; `x` "1 failed"; `alert-triangle` "1 did not finish"; `minus` "no run". It replaces the scatter (B-14). The table is ranked **by failure rate with n** (rate shown at ≥ 5 runs); durations are in minutes |
| Takeaway | "12 runs in 90 days, 1 failed (8 Oct, timeout), 1 did not finish. Missing runs do not prove a schedule ran." |
| Tier · window | Recorded · charts window |
| Available | Today |

### 5.2 Improve impact visuals

#### V-10 Outcomes by process

| Field | Spec |
|---|---|
| Question | Who decided what, week by week? |
| Metrics | M-15, M-16 |
| Source | The `listProposalOutcomeRows` projection (P4-3) over `proposals` (`storage/repositories/proposals-repository.ts:497-525`). Fields: `status`, `gateDecision.{outcome,gate}` (`commands/proposal/proposal-types.ts:113-117`), `isProceduralRejection` (`:355-360`) |
| Classes (`classifyOutcome`) | **judge-accept:** accepted/reverted ∧ `outcome='auto-accepted'` ∧ `gate='triage'` (the drain always stamps this, `commands/proposal/drain.ts:71,170-176`). **you-accept:** other accepts, **including `staged`+accepted** ("the judge passed it first", footnote; human provenance at `commands/proposal/repository.ts:1269`). **judge-reject:** `auto-rejected`, not procedural. **you-reject:** rejected, not auto, not procedural. **procedural.** **decider unknown:** any row the rules cannot place; it is **not stacked**, shown as a per-row text count and a table column. `review.decidedBy` (G3) overrides every inference when present |
| Form | Small multiples (`chartGrid`), one row per process: reflect, distill, consolidate (promotions), consolidate-pair (retirements), extract, other automated, plus a folded muted row "your own proposals". Weekly stacked columns by **decision week**, in the fixed order judge-accept, you-accept, judge-reject, you-reject, procedural. Labels go outside the marks; the top row is direct-labelled |
| Right column (creation cohort, 90 d) | "Of 58 created: 41 accepted, 12 rejected, 5 waiting. You accepted 11 of 15 you decided (73%, 48–89%)." The percentage appears only at ≥ 10 decided by you |
| Caption note | "Bars: when it was decided. Right column: what happened to what was created in the window." |
| Takeaway | "reflect, 12 weeks: 58 decided; 41 accepted (30 by the judge, 11 by you); 12 rejected; 5 closed procedurally." |
| Reverts | Counted on their accept week here. They appear in V-13 on their revert week |
| Tier · window | Recorded + Classified · Last 90 days |
| Available | Today; G3 sharpens it |

#### V-11 Review flow

| Field | Spec |
|---|---|
| Question | Is review keeping up? |
| Metrics | M-17, M-21 |
| Form | One chart: **waiting for you at week end**, a step line `--s1` with a marker every week. Plus text: "This week: 12 arrived, 3 decided by the judge, 9 decided by you; 12 waiting for you now. Median wait to your decision: 2.1 days (p75 5 days, n=40)." Proposals expired during a week count as "closed procedurally" in the text, not as decided by you |
| Tier · window | Recorded · Last 12 weeks (reopens approximated, footnote) |
| Available | Today |

#### V-12 Library change

| Field | Spec |
|---|---|
| Question | What did improve add to and remove from your library? |
| Metric | M-26 |
| Source | Accepted proposals by kind: create (no `beforeHash`, `commands/proposal/proposal-types.ts:262`), promotion (`promotionSource`, `:292-301`), retire (`:331-336`, reason `:161-189`), edit; `memoryCleanup.archived[]` (`core/improve-types.ts:103-125,835-846`) |
| Form | Weekly diverging columns on "Assets added or removed". Above zero: created `--s1` (promotions included, with the label "includes promotions"). Below zero: retired or archived `--s2`. An explicit labelled "0" rule. **Edits are a separate thin row** below, "Edited (no change in count)", as `--s6` columns on their own y-scale. Derived memories form a third row, or read "Off" |
| Takeaway | "Last 12 weeks: 34 added, 22 retired or archived (net +12). 51 assets were edited." |
| Note | No library-size series until G4. History is never back-calculated |
| Tier · window | Recorded · Last 12 weeks |
| Available | Today |

#### V-13 Harm log

| Field | Spec |
|---|---|
| Question | Has anything improve did needed undoing, or looked bad afterwards? |
| Metric | M-28 |
| Rows | **revert** (`status='reverted'`, review reason `reverted:`, `commands/proposal/repository.ts:1023-1035,2257-2266`); **reopened rejection** (`proposal_reopened`, `:2533-2546`); **risky retirement** (an accepted retire with `retirement.continuityRisk`); **unattended accept later reverted**; **run failed or did not finish**; **flag** (below). Lost queries come in P6-2 (D-32) |
| Flag | The first negative user feedback in [accept, accept + 14 d) on an asset with no negative user feedback in [accept − 28 d, accept). **Base rate:** for each week start t, take the assets with ≥ 1 user appearance in [t − 28 d, t), no accepted change in [t − 28 d, t + 14 d) and no negative in [t − 28 d, t). The rate is the share of those with ≥ 1 negative in [t, t + 14 d), pooled. **Eligibility line:** "Checked 12 of 40 changes. The other 28 had negative feedback in the 28 days before, which is often why improve changed them." **Footnote:** "Unchanged assets with recent use get a first negative within 14 days 3% of the time (n=1,140 asset-weeks). Changed assets are not a random sample, so treat a flag as a reason to look, not as a verdict." |
| Form | **A newest-first table, which is the primary view**, plus an event strip on daily bins at 90 d, with shapes per §7.6. Never a rate. Never on a gain chart |
| Takeaway | "3 items in 90 days: 2 reverts (27 Sep, 12 Oct), 1 flag after a change (3 Oct)." |
| Tier · window | Recorded; Linked (flags) · Last 90 days |
| Available | Today (G2 extends accept dates past 90 d) |

#### V-14 Cost

| Field | Spec |
|---|---|
| Question | What did each process use, and what lasted? |
| Metrics | M-22, M-23, M-29 |
| Form | Small multiples per process: weekly columns of one measure (Measure select), single hue `--s1`. A thin failures row in `--fail` labelled "failed". Coverage under 80% → hatch (R2) |
| Per kept change | Over the **mature window** [now − 90 d, now − 14 d): tokens, calls and model minutes spent in that window ÷ proposals **created** in it that are kept today. Both numbers are printed. Header: "Changes proposed 3 Aug – 18 Oct (76 days), excluding the last 14 days, which have not had time to be kept". Fewer than 5 kept → "— (3 kept)". Footnote: "Includes manual `akm reflect`/`akm distill` runs. Not monetary cost." |
| Takeaway | "reflect: 1.2M tokens over 140 calls; 18 kept changes, 66k tokens per kept change." |
| Tier · window | Recorded · Last 90 days (bounded by data start) |
| Available | Today |

#### V-15 Changed assets (D-01)

| Field | Spec |
|---|---|
| Question | How were the assets improve changed used afterwards? |
| Metric | M-30 |
| Source | Accepted edit proposals (reflect, distill edit, feedback fix). Accept time from `acceptedAt` (G2), else the `promoted` event (`commands/proposal/repository.ts:1820`). Pre window [t−28 d, t); post window [t+1 d, t+29 d) |
| Columns | ref (link); process; accepted; **appearances in results** (search + curate per-hit rows, `source='user'`; `commands/read/curate.ts:188-197`, `indexer/usage/usage-events.ts:200`), shown as "12 of 812 searches → 19 of 1,040"; top-5 appearances (all sources); selects (all sources); feedback +/−; proposal link. A ratio appears only at ≥ 20 appearances in both windows |
| Rules | **No context row and no difference column, computed or sortable.** An asset changed again in [t, t+29 d) shows "changed again 12 Oct" with "—" post cells. Rows under 5 appearances in both windows collapse under "14 changes with too little use to read". Default sort: accept date, newest first |
| Eligibility | "Showing changes accepted 31 Aug – 3 Oct: the only ones with 28 days of data on both sides (data starts 3 Aug). 23 of 61 reflect changes qualify." |
| Subtitle | "Linked: these assets were used after the change. This does not show that the change caused it. Assets chosen because they had a bad stretch tend to look better later anyway." |
| Takeaway | "23 changes have a full month before and after. Usage overall rose 28% between those windows." The "9 more / 6 fewer / 8 about the same" sentence is allowed only with the threshold stated (±2 appearances and ±10% of search share), and DV may drop it at R1 |
| Narrow | Priority columns: ref and accepted (1); appearances (2); the rest (3) |
| Tier · window | Linked · Changes accepted 31 Aug – 3 Oct |
| Available | A server join (G1-c); source-attributed selects after G10 |

#### V-17 Judge and you (table)

- **Question:** "When the judge and you both looked, did you agree?"
- **Form:** a 2×2 HTML table: judge passed (incl. `staged`) / judge unsure or failed × you accepted / you rejected. Shown for 90 d and all time. The disagreement rate appears only at ≥ 10: "you rejected 6 of 40 judge-passed (15%, 7–29%)".
- **Copy:** "Your decisions are the reference here, not ground truth. These proposals are not a random sample."
- **Tier:** Classified.
- **Available:** today.

### 5.3 Other pages

- **V-18 Asset improve history** (rail).
  - **Question:** "What has improve done to this asset, and how was it used?"
  - **Form:** a proposals row of §7.6 diamonds (created hollow `--s1`, accepted filled `--s1`, rejected filled `--s6`, revert down-triangle `--fail`) on weekly bins, above a weekly appearances sparkline (SVG), plus a table of the asset's proposals.
  - **Takeaway:** "3 proposals, 2 accepted, last 4 Oct. Appeared in 41 searches in 90 days."
  - **Tier:** Recorded + Linked.
  - **Source:** `/api/asset/improve` (P4-7).
- **V-19 Queue summary** (Proposals, D-13).
  - **Question:** "How old is what's waiting?"
  - **Form:** a sentence plus a table of sources × age bands, each row with an SVG `ageBar` (`--age-1..3`, `--age-unknown`) **on `--surface` only**, and counts as text links. Copy says "older is stronger".
  - **Takeaway:** "12 waiting: 3 under a day, 6 within a week, 3 older (oldest 9 days, distill)."
  - **Source:** `proposalBacklog` (`commands/ui/metrics.ts:47-72`).

### 5.4 P6-3 matched comparison: required spec (not built in v1)

1. **Question:** "Did assets improve changed appear in more of your searches afterwards than comparable assets it did not change?"
2. **Unit:** asset × change. Pre [t−28 d, t), post [t+1 d, t+29 d). Exposure = (search + curate appearances, `source='user'`) ÷ total user searches, per 100.
3. **Treated:** accepted edits with full windows and no second change before t+29 d.
4. **Comparison:** refs planned in the same run but skipped for budget (`improve_skipped` with `reason: budget_exhausted*`, `commands/improve/loop-stages.ts:384-398`; confirm per-run planned refs exist, or add them). Exclude any asset changed in [t−28 d, t+29 d). Each comparison asset gets the treated asset's t.
5. **Matching:** exact on lane and process; within that, by pre-exposure tertile and pre-negative (yes/no).
6. **Estimand:** the mean within-stratum (post − pre) difference, treated minus comparison.
7. **Interval:** a stratified permutation, 10,000 draws, 95%.
8. **Gates** (all must pass, or nothing is shown): ≥ 20 treated and ≥ 20 comparison; ≥ 3 strata with both groups; a placebo check on two pre windows whose interval contains 0.
9. **Display:** one sentence plus one interval bar with a zero rule. Tier "Linked (matched comparison)", with the copy "Comparable assets are ones improve planned to change in the same runs but skipped for time. This is better evidence than before-and-after alone, but it is still not proof."
10. **Constants live in `derive.ts`** and change only through a DV-reviewed PR.

### 5.5 Cut or deferred

| Item | Status | Reason |
|---|---|---|
| Effect number, dumbbells, bootstrap, context row | Cut (P6-3 replaces them) | D-01 |
| IQR band; moving baseline; 3σ normal limits | Cut | D-02 |
| Activity chart (V-07 v1) | Replaced by the Feedback and use card | D-31 |
| Retirement follow-through (V-16) and the lost-query harm row | P6-2 | D-32 |
| Paired arrivals/decisions columns | Cut | Judge decisions make them look balanced |
| Process colour map | Cut | D-34 |
| 7d and 24h charts windows | Cut | D-30 |
| "Since your last visit" | Cut | D-33 |
| Chart arrow-key stepping | P6-8 | D-28 |
| Top-3 selection share; adoption; memory-inference exposure; extraction outcomes; library health tiles | P6 | G10/G4 needed |
| M-27 select-attribution coverage | Cut ("selects: all sources" until G10) | Heuristic join |
| Wilson interval in p-chart tooltips | Cut | Two interval concepts confuse readers |
| Weekend tint; latency p95 below 100 samples | Cut | Noise |

---

## 6. Metric dictionary

**Conventions**
- **Windows** are UTC, closed-open. Weeks are ISO weeks starting Monday 00:00 UTC. Pulse blocks are trailing 7 days (R5).
- **"User"** means `source='user'`, which includes your agents and hooks. **The prompt hook writes curate records, not searches** (its nested search passes `skipLogging: true`, `commands/read/curate.ts:236-249`). So search rates cover explicit `akm search` calls only, and the hook moves curate counts and per-asset curate appearances.
- **Where code lives** (D-54):
  - Shared statistics (`wilson`, `isoWeekStart`, `zeroFill`, `nearestRank`, `binomialQuantile`) are in `commands/metrics/stats.ts`.
  - UI-only derivations (`classifyOutcome`, `pChart`, cohorts, `keptAsOf`, harm assembly, misses normalization) are in `commands/ui/derive.ts`.
  - The UI never recomputes a metric in the browser.
- **The parity test** (`tests/ui-metrics-parity.test.ts`) asserts that the UI and `akm metrics`/`akm proposal list` agree on the same fixture for: pending count (stash-scoped), searches, no-result count, signed feedback ±, model calls and tokens.
- **Constants** (Q-18): `MIN_SEARCHES=30`, `MIN_SIGNED=10`, `MIN_DECIDED=10`, `MIN_KEPT=5`, `MIN_APPEAR=20`, `KEPT_DAYS=14`, `REPEAT_MERGE_MIN=10`, `ACTIVE_STALE_H=6`.

| ID | Metric | Definition / formula | Source | Bin | Min n | Display | Caveat | Status |
|---|---|---|---|---|---|---|---|---|
| M-01 | Searches | Summary rows (`event_type='search'`, `entry_ref IS NULL`, user). Repeats of the same normalized query from the same source within 10 min count once; the table shows both counts | `usage_events` (`commands/metrics/collect.ts:270-271`) | day / week | — | count columns | Explicit `akm search` only; curates are excluded | v1 |
| M-02 | No-result rate ("found nothing") | M-01 rows with `resultCount=0` ÷ M-01 rows **with** a `resultCount` | `metadata.resultCount` (`commands/read/search.ts:398-410`) | block / week | 30 | p-chart | Includes registry hits as "found". A floor on failure, not a measure of success | v1 |
| M-02c | Curate came back empty (context) | curate summary rows with `itemCount=0` ÷ curate rows | `usage_events` curate | week | 30 | table only | **Not a failure rate**: the hook curates every prompt | v1 (table) |
| M-03 | Result-count coverage | rows with `resultCount` ÷ summary rows | same | window | — | coverage panel | Bins over 10% missing are treated as below the minimum | v1 |
| M-04 | Search time p50 / p90 | nearest rank of `totalMs ≥ 0`, with one filter for the tile and the chart | `metadata.totalMs` | week | 20 (p95 needs 100) | lines + "timed n of N" | Performance, not quality | v1 |
| M-05 | Selects | `select` events, deduped per (searchTs, ref) | `events` (`indexer/usage/show-usage.ts:59-67`) | — | — | labelled "(all sources)" | No source until G10 | v1 (labelled) |
| M-06 | Search-to-select rate | searches referenced by ≥ 1 select `searchTs` ÷ user searches with hits | events + usage | week | 30 | table only | Replaces "Selects per search" (B-06) | v1 table; line after G10 |
| M-07 | Misses | distinct normalized queries with `resultCount=0` on ≥ 2 UTC days (repeat), or on 1 day (recent) | `usage_events.query` | 30 d | — | list | Redacted text | v1 |
| M-08 | Top-3 selection share | selects with `0 ≤ rankPosition ≤ 2` ÷ selects with rank ≥ 0, user | `select.metadata` | week | 30 | line | Limit and registry ordering affect it | after G10 (P6) |
| M-09 | Negative-feedback share | negative ÷ (positive + negative), `source='user'`, signed, merged per (asset, UTC day, signal) | `usage_events.signal` (`commands/feedback-cli.ts:214-226`) | block | 10 | tile (V-02 rules) | Voluntary and agent-driven. Never show the positive count alone | v1 |
| M-10 | Judge auto-accept share | judge-accept ÷ all accepts | proposals | 90 d | 10 | text | Depends on drain configuration | v1 |
| M-11 | Library size | `totalEntries` per `index_completed` | G4 | per run | — | step line | Current value only until G4 | after G4 |
| M-12 | Recently-used share | assets with ≥ 1 user appearance in 90 d ÷ indexed | usage + G4 | 90 d | — | tile | Bounded by retention | P6 |
| M-13 | Derived-memory exposure | user searches with a `downstreamAttribution.memoryInference` hit ÷ user searches with hits | per-hit metadata (`indexer/search/search-attribution.ts:73-85`) | week | 30 | line | Surfacing is not causation | P6 |
| M-14 | Proposals created | count by `source`, by creation week | proposals | — | — | counts | Volume is not value | v1 |
| M-15 | Decided by class | count by decision week × class (§5.2 V-10) | proposals; `decidedBy` (G3) | week | — | stacked columns | **Classified.** `staged`+accepted = you. A "decider unknown" class exists | v1 |
| M-16 | Your accept rate (cohort) | you-accept ÷ (you-accept + you-reject), creation cohort, with the pending share | as M-15 | 90 d | 10 | text + Wilson | Right-censored | v1 |
| M-17 | Waiting for you | pending at week end; arrivals and decisions by decider (text) | `createdAt`, decision time, `reviewHistory` | week | — | step line | Reopens approximated. "Now" equals the Proposals page | v1 |
| M-18 | Rejected by you | count of you-reject | as M-15 | window | — | count | Classified | v1 |
| M-19 | Revert rate | reverted ÷ **revertable** accepts accepted ≥ 14 d ago. "2 of 41 revertable changes accepted 14+ days ago were reverted" | `status`, `acceptedAt` (G2) or the `promoted` event | 90 d | 10 | text + Wilson | Creates cannot be reverted, so they are excluded | v1 |
| M-20 | Kept | accepted ≥ 14 d ago and not reverted | as above | 90 d | — | count + "all accepts as of today" | A created note removed later by hand or by a retirement is not counted as reverted | v1 (Improve only) |
| M-21 | Time to your decision | median and p75 of (decided − `waitingSince`), human decisions only | proposals | 90 d | 10 | text | Judge decisions excluded | v1 |
| M-22 | Model calls / tokens / time | sums per process per bin | `llm_usage` (`commands/metrics/collect.ts:157-196`) | week | — | small multiples | Time is summed call time. Not money | v1 |
| M-23 | Token coverage | `usageCalls ÷ calls` | same | per bin | — | text, hatch under 80% | Unknown is not 0 | v1 |
| M-24 | Improve runs finished ok | `ok=1` ÷ runs, **excluding `dry_run`** | `improve_runs` | block / week | 1 (counts), 5 (rates) | count fraction | Manual runs are included and labelled | v1 |
| M-25 | Tasks finished ok | completed ÷ (completed + failed + active > 6 h) | `task_history` | block / week | 5 per task for a rate | count; ranked by rate | Missing runs are invisible | v1 |
| M-26 | Library added / removed | created + promotions − retired − archived, by accept week; **edits in their own row** | proposals, `memoryCleanup.archived` | week | — | diverging + edits row | Your own edits are invisible | v1 |
| M-27 | *(cut: select-attribution coverage)* | — | — | — | — | — | Use "selects: all sources" until G10 | cut |
| M-28 | Harm items and flags | reverts, reopened rejections, risky retirements, unattended accepts later reverted, failed or unfinished runs, flags (with base rate and eligibility) | §5.2 V-13 | 90 d | none | table + strip | Never netted | v1 |
| M-29 | Cost per kept change | resources in [now−90, now−14) ÷ proposals created in it and kept today | M-22, M-20 | mature window | kept ≥ 5 | table | Includes manual runs. Not ROI | v1 |
| M-30 | Changed-asset use | per asset, pre and post: appearances (search + curate, user) out of total user searches; top-5 (all); selects (all); feedback ± | §5.2 V-15 | per change | 20 for a ratio | table | **Linked, not causal.** No difference computed | v1 |
| M-31 | Retirement follow-through | later searches matching a retired note's queries: found the successor / something else / nothing | `retrievalQueries`, `resultRefs` | 90 d | 5 per reason | counts; lost list | Sparse | P6-2 |
| M-32 | Judge/human disagreement | judge-passed (incl. `staged`) ∧ you-reject ÷ judge-passed ∧ you-decided | proposals | 90 d / all | 10 | 2×2 + Wilson | Not a random sample | v1 |
| M-33 | New-asset adoption | created assets with a user select within 30 d ÷ created assets with ≥ 30 d of follow-up | proposals + select | 90 d | 8 | text pair | Source-less selects | P6 |

---

## 7. Design system

### 7.0 Look and feel (contract)

**Character.** Quiet and dense but breathable, in the family of GitHub Primer and Linear. It is native (`system-ui`), flat and typographic.
- **Colour is reserved for data, status and the one accent.** Chrome is neutral gray.
- No decoration, no gradients except the shell column paint (§7.4), no illustrations and no emoji.

**Type roles.** Every text role maps to exactly one token; nothing else is used.

| Role | Token | Weight | Notes |
|---|---|---|---|
| Page title `h1` | `--text-2xl` | 600 | `--leading-tight`; one per page |
| Section and card question `h2` | `--text-lg` | 600 | never larger |
| Sub-section `h3`, table group heads | `--text-md` | 600 | |
| Body | `--text-md` | 400 | |
| Tables, controls | `--text-sm` | 400 | dense |
| Labels, captions, takeaways, tier, axis, chips | `--text-sm` / `--text-xs` | 400 | `--muted` for captions, tier and axis |
| Nav section header | `--text-xs` | 600 | uppercase, `letter-spacing:.06em` (the only tracking) |
| Stat value | `--text-stat` | 600 | `tabular-nums` |
| Refs, paths, shas, commands | `--mono`, **one step smaller** than the surrounding role | inherit | |

`tabular-nums` is set in `base.css` on `table, .tile, .badge, .num`.

**Spacing rhythm** (4px grid)

| Between | Token |
|---|---|
| `h1` and its subtitle | `--space-1` |
| Page header and first section | `--space-6` |
| Sections | `--space-8` (`--section-gap`) |
| Section `h2` and its content | `--space-3` |
| Cards in a grid | `--space-4` |
| Card padding | `--space-5` (`--space-4` at `narrow`) |
| List rows (attention, nav) | `--space-2` block, `--space-3` inline padding, with hairline dividers |
| Toolbar controls | `--space-2`; between groups `--space-4` |

**Surfaces**
- **One card style:** `--surface`, `--hairline`, `--radius-md`, **no shadow**.
- **Cards never nest.** Inside a card, separate content with hairlines or space. An empty state inside a card is an unbordered `state` block; it is dashed only at page level.
- **`--shadow-2`** is used only on things that float: dialog, status bar, mobile menu, and the action bar once stuck (`data-stuck`, set by a sentinel `IntersectionObserver`).
- **Dark elevation** comes from lighter surfaces (`--bg` < `--surface` < `--surface-2`).

**Colour use in chrome.** Only `--accent` is non-neutral: links, the primary button, selected nav and tabs, the focus ring.
- Status tones appear only with a word and an icon.
- Series colours appear only inside figures and their legends.

**Motion.** Only these animate:
- the disclosure chevron (`--dur-fast`);
- the skeleton shimmer;
- the status-bar entrance (`--dur-base`: fade plus a 4px translate);
- hover background colour (`--dur-fast`).

There are no animated charts, page transitions or count-ups. All motion is off under `prefers-reduced-motion`.

**Focus.** `outline: 2px solid var(--focus-ring); outline-offset: 2px`. Inside scroll containers the offset is `-2px`. There are no `box-shadow` rings.

**Density** is fixed. Table rows are 2.5rem, list rows ≥ 2.75rem, controls 2rem. Targets are never under 24px.

**Print** (`@media print`): hide the sidebar and controls, open "Data and details", and use black text on white.

### 7.1 Tokens (`tokens.css`, `@layer tokens`)

This block is the **target set**. A PR adds a token only together with its first consumer, which the unused-token lint enforces (S-02). P2-2 adds only the tokens today's CSS uses, with today's values (0 diff). P2-3 and P2-7 change values. All contrast values below were computed with the WCAG formula.

```css
@layer tokens {
  :root {
    color-scheme: light dark;
    --bg: light-dark(#f5f6f8, #0e1218);
    --surface: light-dark(#ffffff, #161b23);
    --surface-2: light-dark(#eef0f4, #1e2530);
    --border: light-dark(#dde1e8, #2b3340);          /* decorative only (1.31 / 1.36:1) */
    --border-strong: light-dark(#7d8695, #68758a);   /* control edges: ≥3.22 / ≥3.30:1 on bg, surface, surface-2 */
    --text: light-dark(#1a2230, #e6eaf1);            /* ≥13.99 / ≥12.77:1 */
    --muted: light-dark(#586274, #9aa5b6);           /* ≥5.39 / ≥6.19:1 */
    --accent: light-dark(#4338b0, #a5adff);          /* D-40: 8.64 / 8.25:1 on surface; OKLab ΔE vs --s1 = 0.112 / 0.169 */
    --accent-bg: light-dark(#ecebfa, #232a52);       /* accent on it 7.33 / 6.57:1 */
    --on-accent: light-dark(#ffffff, #0e1218);       /* 8.64 / 8.96:1 on --accent */
    --focus-ring: var(--accent);
    --ok: light-dark(#17753a, #4cc26b);   --ok-bg: light-dark(#dff3e6, #153020);
    --warn: light-dark(#8a5a00, #e8b84a); --warn-bg: light-dark(#fbeccb, #3a2f12);
    --fail: light-dark(#c4202c, #ff8179); --fail-bg: light-dark(#fbe0e2, #3d1a1c);
    --info: light-dark(#1f5fa8, #6cb4ff); --info-bg: light-dark(#e0eefb, #14283f);
    --on-danger: light-dark(#ffffff, #0e1218);
    --add-bg: light-dark(#dff3e6, #153020); --add-strong: light-dark(#a8e0bb, #24663b);
    --del-bg: light-dark(#fbe0e2, #3d1a1c); --del-strong: light-dark(#f5b3b9, #7d2b30);
    --hunk-bg: light-dark(#e6edfc, #1c2a4a);
    /* data series (data only). Values on --surface: light 5.45/4.59/4.27/5.79/3.51/4.83, dark 4.55/4.72/5.28/4.62/5.30/6.53 */
    --s1: light-dark(#2f64d0, #4f7fe8);
    --s2: light-dark(#c0560b, #cc6c20);
    --s3: light-dark(#0d8a76, #16a088);
    --s4: light-dark(#8645c0, #9d6be0);
    --s5: light-dark(#a8841a, #ad8a22);
    --s6: light-dark(#6b7280, #94a0b2);
    /* sequential age ramp, validated ordinal (validate_palette --ordinal PASS); use on --surface only */
    --age-1: light-dark(#8fb0ec, #3a5a9e);   /* under 1 day  2.19 / 2.58:1 */
    --age-2: light-dark(#4f7bd8, #5f8ae8);   /* 1–7 days     4.07 / 5.17:1 */
    --age-3: light-dark(#1d3f8c, #a9c3f7);   /* 7+ days      9.80 / 9.74:1 */
    --age-unknown: var(--s6);
    --band: color-mix(in oklch, var(--muted) 18%, transparent);   /* fill is decorative; edges carry it (R5) */
    --band-edge: var(--muted);
    --grid-line: color-mix(in oklch, var(--border) 60%, transparent);
    /* type (D-22) */
    --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --text-xs: .75rem; --text-sm: .8125rem; --text-md: .9375rem; --text-lg: 1.0625rem; --text-xl: 1.25rem;
    --text-2xl: clamp(1.375rem, 1.2rem + .8vw, 1.625rem);
    --text-stat: clamp(1.5rem, 1rem + 3cqi, 1.875rem);   /* inside the tile container */
    --leading: 1.55; --leading-tight: 1.25;
    /* space */
    --space-0_5: .125rem; --space-1: .25rem; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem; --space-5: 1.25rem;
    --space-6: 1.5rem; --space-8: 2rem; --space-10: 2.5rem; --space-12: 3rem; --space-16: 4rem;
    --page-pad: clamp(var(--space-4), 3vw, var(--space-10)); --section-gap: var(--space-8);
    /* shape, elevation, layers, motion */
    --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px; --radius-pill: 999px;
    --hairline: 1px solid var(--border);
    --shadow-2: 0 4px 16px light-dark(rgb(0 0 0 / .18), rgb(0 0 0 / .5));
    --z-sticky: 10; --z-dropdown: 20; --z-overlay: 30; --z-status: 40; --z-skip: 50;
    --dur-fast: 120ms; --dur-base: 200ms; --ease: cubic-bezier(.2, 0, 0, 1);
    /* layout */
    --sidebar-w: 13.75rem; --content-max: 80rem; --measure: 72ch; --rail-w: 18rem; --list-w: 20rem; --toc-w: 12rem;
    --chart-h: 17.5rem; --chart-h-sm: 12.5rem; --chart-h-xs: 7.5rem; --strip-h: 2.5rem; --spark-h: 2rem;
    --target-min: 24px; --control-h: 2rem; --control-h-sm: 1.75rem; --row-h: 2.5rem; --tile-min: 12.5rem;
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"]  { color-scheme: dark; }
}
```

**Token notes**
- `--grid` is removed (it was unused).
- The P2-3 snap mapping:
  | Today | Token |
  |---|---|
  | spacing 5, 6 | `--space-1` or `--space-2` |
  | spacing 9, 10 | `--space-2` or `--space-3` |
  | spacing 14 | `--space-3` or `--space-4` |
  | spacing 18 | `--space-4` or `--space-5` |
  | spacing 28, 36 | `--space-6` or `--space-8` |
  | radius 2, 3, 5 | `--radius-sm` |
  | radius 10, 12 | `--radius-md` (cards) or `--radius-lg` (dialogs) |
  | 17 font sizes | the 6 steps |
- **The token test** (`tests/ui-tokens-contrast.test.ts`) asserts, in both schemes:
  - text pairs ≥ 4.5;
  - `--border-strong` ≥ 3 on bg, surface and surface-2;
  - `--s*` ≥ 3 on `--surface`;
  - `--age-*` ordinal (monotone L, light end ≥ 2:1);
  - `--band-edge` ≥ 3;
  - the focus ring ≥ 3 on bg, surface, accent-bg, add-bg and del-bg;
  - `--on-accent` ≥ 4.5;
  - **OKLab ΔE(`--accent`, `--s1`) ≥ 0.08**.

  It parses `light-dark()` pairs (and, before P2-2, the media-query blocks).

### 7.2 Light, dark, forced colors, contrast

- **Theme control:** a 3-way `segmented` (System · Light · Dark, with icons). It sets or removes `data-theme`, stores the choice through `lib.js` `prefs` (inside try/catch), and dispatches `akm:themechange`.
- **Dark chart chrome:** split lines `--grid-line`, the band fill `--band`, hollow markers filled with `--surface`.
- **Forced colors.** Each component nests its own `@media (forced-colors: active)` (S-03).
  - Badges, chips, tabs and the segmented control get `border: 1px solid CanvasText`.
  - The selected state is `outline: 2px solid Highlight` plus a check icon or bold weight.
  - The focus ring is `Highlight`.
  - `.chart, .spark, .minibar, .agebar, .swatch { forced-color-adjust: none }`, and every colour inside comes from system colours resolved by the probe:
    | Element | Forced-colors value |
    |---|---|
    | data marks | `CanvasText`, distinguished by decals (on) and §7.6 shapes |
    | selected mark | `Highlight` |
    | band | `GrayText` dashed edges, no fill |
    | axes, ticks, grid | `GrayText` |
    | text | `CanvasText` |
    | hollow markers | `Canvas` fill, `CanvasText` stroke |
    | partial hatch | `CanvasText` hatch |
    | age ramp | `--age-3` = `CanvasText` fill; `--age-2` = `CanvasText` 45° hatch; `--age-1` = `Canvas` fill with a 1px `CanvasText` stroke |
    | legend swatches | SVG `<rect>` in the mapped colour, with its decal and a 1px `CanvasText` stroke |
- **`prefers-contrast: more`:** `--border` takes the `--border-strong` value, `--muted` takes the `--text` value, and decals are on.

### 7.3 Component inventory

**Rules**
- One builder in `components.js` (alphabetical exports), one nested block in `components.css` (alphabetical), and one gallery section covering variants × states (default, hover via `data-force="hover"`, focus-visible, selected, disabled or busy, error) × light/dark.
- A builder lands with its first consumer (D-41); the "Lands" column names that task.
- **Pages may not render a control themselves.** A page module containing `class="btn` or `<button` outside the builders fails a source-scan ratchet, which is emptied by the end of P3 (S-22).
- **One primary per view.** A render with more than one `data-variant="primary"` fails a component test.

| Component | Builder | Markup and visual spec | States and a11y | Lands |
|---|---|---|---|---|
| Button | `button({label, variant='secondary', size='md', icon, kbd, busyLabel})`, `linkButton(...)` | `<button class="btn" data-variant="primary\|secondary\|danger\|ghost" data-size="sm\|md">`. md `--control-h`; sm `--control-h-sm`; `--text-sm` 600; `--radius-sm`. Primary: `--accent` / `--on-accent`. Secondary: `--surface` + 1px `--border-strong`. Danger: `--fail` / `--on-danger`. Ghost: transparent / `--accent`, hover `--accent-bg` | Busy = `aria-disabled="true"` + `busyLabel`, with a locked `min-inline-size`. Hover changes the background only | P2-5c |
| Field | `field({label, hint, error, required, control})` | `<div class="field">`: label `--text-sm` 600 above; control `--control-h`, 1px `--border-strong`, `--radius-sm`; hint `--text-xs --muted`; error `--fail` + icon | `aria-describedby` → hint and error; `aria-invalid`; "(required)" in the label | P2-5c |
| Tabs | `tabs(name, items, current)` | APG tablist; a 2px `--accent` underline plus 600 on the selected tab; counts in a neutral badge | Arrows, Home/End. Forced colors: `Highlight` underline. Used by Proposals, Search and Editor | P2-5c |
| Chip | `chip({label, count, pressed})`, `chipGroup(label, chips, {multi, radio})` | `<button class="chip" aria-pressed>` (or `role="radio"` within `radiogroup`); `--control-h-sm`, `--radius-pill`, 1px `--border-strong`; pressed: `--accent-bg` + `check` icon + 600 | Source filters, History origins, reject reasons (radio) | P2-5c |
| Checkbox | `checkbox({label, checked, describedBy})` | native input inside `<label class="check-label">`, `accent-color: var(--accent)`, row ≥ 24px | specific group names (B-25) | P2-5c |
| Disclosure | `disclosure({summary, open, body, level})` | `<details class="disclosure">`; summary ≥ 24px with a chevron icon (rotates, `--dur-fast`); section level `--text-md` 600, "Data and details" `--text-sm` | Never for primary status (B-16) | P2-5c |
| Link | base style | `--accent`, underline offset .2em, 1px; in nav, tiles and tables the underline shows on hover/focus only | Visited is not styled | P2-5c |
| Kbd | `kbd(key)` | `<kbd class="kbd">`: `--mono --text-xs`, `--hairline`, `--radius-sm` | Hidden when shortcuts are off | P3-5 |
| Icon | `icon(name, {label})` in `icons.js` | 16×16, `viewBox="0 0 16 16"`, 1.5 stroke, `currentColor`, round caps | `aria-hidden` unless `label` | P2-5c |
| Badge | `badge(text, tone)` | `<span class="badge" data-tone>`: `--text-xs` 600, `padding-block: var(--space-0_5)`, `--radius-pill`, tone bg/fg | Always text. A rejection is `neutral` | P2-5a/b |
| Swatch / dot | `swatch(series)`, `dot(tone)` | `<svg class="swatch" data-series aria-hidden><rect/></svg>` 10×10 | Forced colors per §7.2 | P2-5b |
| Tile | `tile({label, value, sub, tone, href})` | `<a class="tile">` or `<div>`: `container: tile / inline-size`, min `--tile-min`, padding `--space-4`, `--radius-md`, `--hairline`; value `--text-stat` | The whole tile is the target; hover border `--border-strong` | P5-2 |
| Pulse tile | `pulseTile({key, label, value, n, minN, delta:{dir, better, text}, spark, href, lowDataText})` | tile + `data-signal="usual\|unusual-better\|unusual-worse\|low-data"` + `.delta` with an `arrow-up/down`/`minus` icon + word | The name comes from content, starting with the visible label (no `aria-label`). ≥ 44px | P5-2 |
| Sparkline | `sparkline(values, {lo, hi, hollowBelow})` (`charts.js`) | `<svg class="spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden>`; the line uses `vector-effect="non-scaling-stroke"`; dashed band edges; hollow points below n; **no in-progress segment** | Pure SVG via `html` | P5-2 |
| Age bar | `ageBar(counts)` (`charts.js`) | SVG segments `--age-1..3`, `--age-unknown`, 2px `--surface` gaps; counts as adjacent text | Forced colors per §7.2 | P1-10 |
| Chart card | `chartCard({key, question, takeaway, tier, window, total, legend, controls, table, notes, empty, lowData})` | the §5.0 R9 `<figure>`; `container: card / inline-size`; padding `--space-5` | Empty/low-data replace the chart; load failure: "Chart unavailable. The same numbers are in Data and details below." | P3-2 |
| Chart grid | `chartGrid(cards)` | `repeat(auto-fill, minmax(min(100%, 22rem), 1fr))`, gap `--space-4` | Each cell is a chartCard | P5-4 |
| Data table | `dataTable({caption, columns:[{key,label,numeric,unit,priority,sortable}], rows, total, cap})` | `.table-wrap` (`role="region" tabindex="0" aria-label="<caption>, scrolls sideways"`); rows `--row-h`; hairline dividers, no zebra; hover `--surface-2` only for linked rows; sticky `thead` | `<caption>`, `th scope`. Sortable = APG with `aria-sort`. At `narrow`: priority 3 hidden, priority 2 folded under priority 1, plus "▸ All columns". Caps print "Showing 200 of 1,240". Row actions are ghost sm buttons in the last cell | P3-2 |
| Toolbar | `toolbar(label, controls)` | `role="group" aria-label`; gaps per §7.0 | | P3-2 |
| Segmented | `segmented(name, options, value)` | `role="radiogroup"` of `role="radio" aria-checked` buttons; group 1px `--border-strong`, `--radius-sm`; checked `--accent-bg` + 600 + inset 2px | Arrow keys. Redraws in place, never navigates. Only for window, measure and theme | P2-8 |
| Window chip | `windowChip(text)` | `<span class="window-chip">` `--text-xs --muted`, `--hairline`, `--radius-pill`, at the `h2`'s inline end | Text; e.g. "Last 30 days" | P3-2 |
| Status strip | `statusStrip(health)` | `<section class="strip" aria-label="Health">`: icon + word (only the word is toned) + count links + window chip; 2×2 at `narrow` | | P3-2 |
| Attention list | `attentionList(items)` | `<section><h2>Needs attention</h2><ul class="attention">`; rows ≥ 2.75rem: icon, text, verb link at the inline end | ≤ 5 + "+N more"; positive empty state | P3-2 |
| Detail panel | `detailPanel(key)`, `openDetail(key, {heading, body})` | `<aside class="detail" tabindex="-1" aria-labelledby>`: `--surface-2`, `--radius-md`; beside the card at `wide`, below at `medium` and `narrow` | On open, focus the heading; Esc returns focus to the opener. No `aria-live` | P3-4 |
| States | `emptyState`, `errorState`, `sectionError`, `skeleton`, `lowData` | `.state[data-state]`; skeletons at final size | Error `role="alert"` + code + Try again; one polite "Loading <section>…" | P2-5a (exists) / P3-2 |
| Status bar | `statusBar(host)` → `{show, clear}` | `.status-bar role="status"`, `--z-status`, `--shadow-2` | No timer; replaced by the next decision; cleared on navigation | P3-5 |
| Shortcut help | `shortcutHelp(map)` | `<dialog>` with `showModal()`, `--radius-lg` | Native trap; Esc closes and returns focus; holds the shortcuts toggle | P3-5 |
| Inline confirm | `confirmStep({question, confirm, cancel})` | inline, next to the opener | Esc cancels and refocuses; busy = `aria-disabled` | P1-6 |
| Breadcrumb | `breadcrumb(items)` | `<nav aria-label="Breadcrumb"><ol>`, last item `aria-current="page"` | | P3-1 |
| Path | `pathText(abs)` | middle-truncated (`~/…/a/b`), full path in `title`, plus a copy button | "Copied" is announced | P3-9 |
| Term | `term(key)` | dotted-underline `<button popovertarget>` + `[popover]` with the glossary text (§7.5) | Esc closes | P5-4 |
| Route announcer, skip link | `app.js`, `index.html` | `#route-status` sr-only `role="status"` outside `<main>`; skip link at `--z-skip` | One message per route | P1-2 |

**Formatting helpers** (`lib.js` `fmt`, landing in P2-5a):
- `fmt.count` uses thousands separators.
- `fmt.percent` uses one decimal under 10%, otherwise an integer.
- `fmt.tokens` writes "412k" or "1.2M".
- `fmt.duration` writes "2.1 s", "3 min" or "2.1 days".
- `fmt.relative` writes "just now", "N min ago", "N h ago", "yesterday", then "3 Oct".
- `fmt.absolute` writes "2026-11-01 09:12 UTC".
- Every relative time also renders its absolute time, in the cell or as sr-only text (B-46).

### 7.4 Layout and size vocabulary (D-27b)

**One media breakpoint and three container sizes.** No other numbers appear in `@container` conditions (S-06).

| Name | Condition | Used for |
|---|---|---|
| shell | `@media (width < 50rem)` | the sidebar becomes a disclosure |
| `narrow` | container `< 30rem` | one column; `--chart-h-sm`; month labels; priority columns; card padding `--space-4` |
| `medium` | `30rem – 60rem` | the strip on one line; detail panel below; rail stacked above the body |
| `wide` | `≥ 60rem` | cards 2-up; Proposals split (list `--list-w`); asset rail beside; detail beside; Improve "On this page" |
| diff pane | its own container `≥ 56rem` | Side-by-side diff allowed |

At 1440 the page container is 71.25rem, and at 1280 it is about 61rem, so **both are `wide`**. The matrix baselines 1280 for the wide-edge routes (§11.2).

```css
.shell { display:grid; grid-template-columns: var(--sidebar-w) 1fr; min-block-size:100dvh;
         background: linear-gradient(to right, var(--surface) var(--sidebar-w), var(--bg) 0); }   /* B-45 */
main  { container: page / inline-size; padding: var(--page-pad); }
.page { max-inline-size: var(--content-max); margin-inline: auto; }
@container page (width >= 60rem) { .cards { grid-template-columns: repeat(2, 1fr); } .cards > .span-2 { grid-column: 1 / -1; } }
```

### 7.5 Content rules

- **Verbs:** proposed → accepted / rejected / reverted / reopened. Say "Judge (automatic review)".
- **Window chip.** Every section header carries one, in the same place and format:
  - "Last 24 hours"
  - "Last 7 days vs the 8 weeks before"
  - "Last 4 weeks"
  - "Last 30 days"
  - "Last 12 weeks"
  - "Now"
- **Week start.** The first weekly chart on a page adds "Weeks start Monday 00:00 UTC (Sunday 17:00 your time)", computed from `Intl.DateTimeFormat().resolvedOptions().timeZone` and shown only when the offset is not 0.
- **Explanations.** One mechanism: the inline `term()` popover at first use on a page, plus "How to read this page" on Improve only. Glossary keys:
  - judge, deferred, judge-uncertain;
  - belief state, write target, consolidate-pair, continuity risk;
  - token coverage;
  - the four tiers;
  - kept;
  - your usual range;
  - the bracket after a rate.
  The copy is in Appendix D.
- **Errors:** what happened + why + what to do, with the code kept.
- **Empty states:** why + what fills them + one next action. Text, an icon and an action only.
- **Forbidden in UI strings** (scanned, S-33): improved, caused, boosted, saved, ROI, PASS, and emoji (`\p{Extended_Pictographic}`). "score" is allowed only in "Ranking details".
- **Shipped-asset lint:** strings under `src/assets/**` must not use the dead `type:name` ref grammar (`scripts/lint-shipped-assets.ts`).

### 7.6 Icons and marks (D-35)

**UI icons**
- They live in `icons.js` as `icon(name)`: inline SVG, 16px, 1.5 stroke, `currentColor`, drawn in-house.
- v1 is capped at 24: `check, x, alert-triangle, alert-circle, info, chevron-right, chevron-down, arrow-up, arrow-down, minus, external, copy, refresh, undo, thumb-up, thumb-down, search, filter, keyboard, sun, moon, monitor, flag, dot`.
- No icon font. No emoji. No Unicode glyphs used as icons.

**Data marks.** Each is an SVG or ECharts `symbol` **path** in one `SHAPES` constant in `chart-view.js`. **One meaning per shape, on every page.**
- Rule: neutral context is gray, the proposal lifecycle is always a diamond, and harm is warm-toned with a unique shape.
- Size: ≥ 10px visible, with a 24px hit layer.
- Strip rows carry the word and the mark in the row label.

| Meaning | Shape | Fill | Token |
|---|---|---|---|
| Improve run, ok | circle | filled | `--s6` |
| Improve run, failed or did not finish | cross | stroke | `--fail` |
| Full reindex | hexagon | filled | `--s6` |
| Retirement batch (≥ 3 in a UTC day) | horizontal bar | filled | `--s6` |
| Config change (after G9) | asterisk | stroke | `--s6` |
| Proposal created | diamond | hollow | `--s1` |
| Proposal accepted | diamond | filled | `--s1` |
| Proposal rejected | diamond | filled | `--s6` |
| Revert | down-triangle | filled | `--fail` |
| Reopened rejection | up-triangle | hollow | `--warn` |
| Negative-after-change flag | pennant (the `flag` path) | filled | `--warn` |
| Retirement accepted despite a continuity warning | square | hollow | `--warn` |
| Lost query (P6-2) | circle-slash | stroke | `--fail` |
| Automation cell (V-09) | the `check` / `x` / `alert-triangle` / `minus` icon + text | — | tone + word |

---

## 8. Engineering standards

**Owner requirement.** Both the code and the UI must be clean and professional grade. Every PR in this epic must use **modern CSS** and **clean coding practices**:
- modern CSS: design tokens, `@layer`, logical properties, container queries, nesting, `clamp()`, low-specificity selectors, `light-dark()`/`color-scheme`, `prefers-reduced-motion`, `:focus-visible`;
- clean code: small single-purpose modules, one way to do each thing, no dead or speculative code, explicit names, tests first for bugs, and surgical diffs (AGENTS.md).

§8.8 is the enforceable form of this requirement. Each child issue lists the checklist items that apply to it, and reviewers reject any PR that violates one.

### 8.1 CSS architecture

**Files** (D-10). Flat in `src/assets/ui/`, with `EMBEDDED_UI` generated (P0-4).

| File | Layer | Holds |
|---|---|---|
| `layers.css` | — | only `@layer reset, tokens, base, layout, components, pages, utilities;` |
| `tokens.css` | tokens | §7.1 |
| `base.css` | reset, base | box-sizing; `:where()` element rules; links; the focus ring; `[hidden]`; `.sr-only` (`clip-path: inset(50%)`, B-51); the skip link; `tabular-nums`; the **single** reduced-motion block; print |
| `layout.css` | layout | shell, sidebar, main, page, cards grid, review split, rail, On this page |
| `components.css` | components | one nested block per component, in alphabetical order |
| `pages.css` | pages | rare page-only rules (editor bar, commit timeline, diff internals) |
| `utilities.css` | utilities | `.muted .small .num .r .wrap .mono .pre-wrap .text-ok/warn/fail` |

**Rules.** Their numbers match §8.8.
1. Tokens only for colour, space, radius, font size, shadow, z-index and duration. Allowed literals: `0`, 1px/2px hairlines, %, unitless line-heights, `fr`, and the colours `transparent`, `currentColor`, `inherit` and the CSS system colours.
2. A token exists only if CSS or UI JS references it.
3. A class is the subject of **one** top-level rule across all files. Its states, `@container`, `@media (forced-colors|prefers-contrast|print)` and `@supports` variants nest inside that rule.
4. Specificity ≤ (0,3,0). Nesting ≤ 2 levels. No IDs. No type-qualified classes. Base element rules go inside `:where()`.
5. Logical properties only. `width`/`height` are allowed inside media and container preludes.
6. `@media` only for the layout breaks of the approved design B (50, 64, 72 and 90rem), reduced motion, contrast, forced colors, colour scheme and print. `@container` lengths only from {30rem, 60rem, 56rem}.
7. `!important` only inside the reduced-motion block in `base.css`.
8. No descending specificity, duplicate properties, shorthand overrides or unknown properties.
9. `dvh`, never `vh`. `clamp()` only in `--page-pad`, `--text-2xl` and `--text-stat`.
10. State is styled from ARIA and `data-*` attributes. There are no `.active` or `.selected` classes.
11. `box-shadow` only from a token: the edge lines (`--edge-*`), the focus halo and `--shadow-float`. Design B draws its selected-row and attention edges as inset shadows.
12. No `.card`/`.tile` nested inside `.card`.
13. `letter-spacing` only from a `--tracking-*` token (design B tracks headings, labels and caps).
14. New component blocks are inserted alphabetically, never appended at the end of a file.

**`scripts/lint-ui-css.ts`** is a brace-aware scanner with fixtures in `tests/lint-ui-css.test.ts`, run by `bun run lint`. It enforces 1, 4–7, 9–11 and 13; rule 1 covers margins, padding, gaps, radii and font sizes, not layout sizes. The stylesheets have no findings, so there is no allowlist.

**Biome** override for `src/assets/ui/**/*.css`, at `error` from P0-3:
- `style.noDescendingSpecificity`
- `complexity.noImportantStyles` (with an override for `base.css`)
- `suspicious.noDuplicateProperties`
- `suspicious.noShorthandPropertyOverrides`
- `correctness.noUnknownProperty`
- `nursery.noDuplicateSelectors`

On today's file only `.check` (B-03) trips these, so P0-3 carries that one-line rename if P1-3 has not merged.

### 8.2 JS conventions and security

**Modules**
| Module | Role |
|---|---|
| `lib.js` | escaping (`html`, `mount`, `esc`), `api`/`post` with signal, `fmt`, `prefs` (the only storage access), flash, `actionForm` |
| `components.js` | builders only: no fetch, no listeners |
| `icons.js` | SVG icon builders |
| `chart-view.js` | `wireChart`, `resolveColor`, `SHAPES`, the pure option builders |
| `charts.js` | inline SVG: `miniBar`, `proportionBar`, `sparkline`, `ageBar` |
| `shortcuts.js` | the scoped key layer and the help dialog |
| `app.js` | router, shell, announcer, focus, abort, theme, boot check |
| page modules | `render(ctx)` returns `html`; wiring through `ctx.after`; use `ctx.api`; no module-level mutable state |

**Rules**
1. Markup is written only through `html` + `mount` (`lib.js:39`). These are banned: `innerHTML` elsewhere, `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval`, `new Function`, inline handlers, `confirm`/`alert`/`prompt`, and off-host URLs.
2. Hash URLs are built only by `assetHref`, `proposalHref`, `listHref`, `searchHref` and `newKnowledgeHref` (using `URLSearchParams`). Each is unit-tested with `"><svg onload=1>`, `javascript:alert(1)` and `#/x?y`. Markdown links stay scheme-allowlisted (`markdown.js:6,33`).
3. No `style=` except a single custom property (`style="--w:42%"`, local prop allowlist `['--w']`). Prefer SVG attributes.
4. **ECharts**
   - `aria: {enabled:true, label:{enabled:false}, decal:{show:<media>}}` (D-29).
   - The tooltip uses `renderMode:'richText'`, `confine:true`, `enterable:true`, `transitionDuration:0`, `hideDelay:300`, `triggerOn:'mousemove|click'`, and Esc → `hideTip` (D-11).
   - `tooltipText` returns plain text. Every data-derived string goes through `richSafe(s)`, which strips `{ } |` and caps at 120 chars.
   - No string-template formatters on data. Axis formatters return text.
   - SSR test: a series named `<img src=x onerror=alert(1)>{a|x}` renders as literal text through SSR and the tooltip formatter.
5. **Free text from the server** (judge reasons, validation messages, queries, commit subjects, harm descriptions) passes `redactCredentialPatterns` (as `commands/read/search.ts:363` does) **and** `scrubUrlCredentials` (`server.ts` `sendJson`). It is capped at 280 chars with "…". Lists are capped and report `total`. The server never sends HTML.
6. Listeners attach to rendered nodes, or go in `ctx.after` with a disposer. `window`/`document` listeners appear only in `app.js` and `shortcuts.js`.
7. Every request uses `ctx.api` (bound to `ctx.signal`); the router aborts on navigation.
8. Storage only through `lib.js` `prefs` (try/catch). Allowed keys: theme, shortcut toggle, diff mode, review progress.
9. **The session token** lives only in `sessionStorage` under `akm-ui-token` (`lib.js:46-58`). It never appears in `localStorage`, an `href`, a fetch URL, a log, a copied command or the DOM (a Playwright test checks this).
10. **Copy buttons** copy command templates with placeholders, never redacted values. Without `navigator.clipboard`, the text is selected in a readonly input with "Press Ctrl+C".
11. **CSP** stays `STATIC_CSP` (`server.ts:113-115`), pinned by a test. `style-src 'unsafe-inline'` remains for the ECharts SVG and `--w`. Trusted Types are out of scope.
12. **Focus.** After a route render, restore focus or focus the `h1` (`preventScroll`), and announce "<Title> loaded". During async actions the acting control keeps focus (`aria-disabled`), then focus moves to the result. Focus never lands on `body`.
13. **Boot check** (D-53). If `CSS.supports('color','light-dark(#000,#fff)') && CSS.supports('selector(:has(a))')` fails, mount one notice: "This browser is too old for akm ui. Use Chrome 123+, Firefox 121+ or Safari 17.5+."
14. **Clean code**
    - Functions do one thing. A page module stays under 8 KB gzip.
    - No dead code, commented-out code or speculative options.
    - Names say what a thing is (`waitingForYou`, not `data2`).
    - No `bun:test` imports under `src/`.
    - Prefer data tables and pure functions over branching UI code.
    - Every bug fix starts with a failing test.

### 8.3 `wireChart` v2 (P2-6a…c)

```js
export function wireChart(ctx, target /* element | data-chart key */, build /* () => option */,
                          { onSelect /* point → void; opens a detailPanel; never a write */ } = {}) → { redraw() }
export function resolveColor(name /* '--s1' | 'CanvasText' */) → 'rgb(...)'   // lands in P2-2
```

1. **Addressing.** It takes an element, or a key resolved as `[data-chart=key]` inside the scope. No fixed ids.
2. **Listeners.** There is no `change` listener on `<main>`; callers call `redraw()`. The `toggle` resize is scoped to `closest('[data-chart-scope]')`. Remove the synthetic change at `proposals.js:158` (done in P1-10).
3. **Colours.** `resolveColor` uses **one probe per document** (`probe.style.color = var(name)`, read through `getComputedStyle(probe).color`), cached until `akm:themechange` or a change in `prefers-color-scheme`, `forced-colors` or `prefers-contrast`. `SERIES = ['--s1'…'--s6']`.
4. **Decals:** `aria.decal.show = matchMedia('(forced-colors: active), (prefers-contrast: more)').matches`. An SSR test asserts that a `<pattern>` appears when it is true.
5. **Defaults.**
   - `animation:false`; `minInterval:1` on count axes; category axes only.
   - A fixed `grid.left` for stacked sub-charts (R12).
   - After init: `svg.setAttribute('aria-hidden','true')`.
6. **Failure.** A rejected `import('./echarts.js')` → "Chart unavailable. The same numbers are in Data and details below."
7. **Laziness** (P2-6c). Init on `IntersectionObserver` entry, so ECharts is not requested before a chart card is near the viewport.
8. **Pure builders.** Each returns `{option, summary(data), table(data)}`, and each lands as its own PR (P5-1a…e):
   - `pChartLine`
   - `stackedColumns`
   - `divergingColumns`
   - `stepLine` (+ simple `lines`)
   - `eventStrip` (category bins, snapping with counts)

   `verticalBars` is kept. There is no `dumbbell` and no `pairedColumns`.

### 8.4 API and route design

**New GET routes**
- Read state.db through `withReadonlyStateDb` (`commands/ui/api.ts:97`), and index.db through `openReadonlyExistingDatabase` + `closeDatabase` (`api.ts:36`).
- Use `section()` error isolation.
- Each route **lives in its own module** (`pulse.ts`, `impact.ts`, `misses.ts`, `asset-improve.ts`). `api.ts` gets one import and one `ROUTES` line, inserted alphabetically.
- Each sends `Server-Timing` and has a section in `docs/reference/ui-api.md` (alphabetical).
- The read-only test iterates `Object.keys(ROUTES)`.

| Route | Purpose | Shape (abridged) | Budget |
|---|---|---|---|
| `GET /api/overview/pulse` | Pulse, attention, improve line, set-up rows | `{asOf, tiles:[{key, value, n, minN, center, sigmaZ, signal, blocks:[{start,end,k,n,rate,lo,hi,belowMin,inBaseline}], text}], runs:{improve:{ok,total}, tasks:{ok,total,didNotFinish}, firstFailure}, attention:[{severity,kind,count,oldestAt?,href}], attention.misses, improveSentence:{…§5.1 V-04}, setup:[{key,done,command}]}` | ≤ 4 KB, ≤ 100 ms |
| `GET /api/overview` (changed) | Charts window 30d/90d | Bins per R1 with `dataStart` per store; drops `health.report.pendingProposals` (sends a count) and `acceptRateBySource`; caps `zeroResultQueries` at 50 per bin + `total`; the client keeps `health` across window changes | ≤ 25 KB, ≤ 250 ms |
| `GET /api/improve/impact?since=90d\|all&bundle=` | Improve sections | `{window, dataStart, weeks[], outcomes:{byProcess, cohort, decidedUnknown}, flow:{waitingAtEnd[], thisWeek:{arrived, judgeDecided, youDecided}, timeToDecision}, changes:{created[], retired[], edited[], derived?}, harm:{total, eligible, checked, baseRate:{rate, n}, items[≤200]}, cost:{byProcess, perKept:{window, rows}}, changedAssets:{eligible, total, rows[≤200], lowUse}, judge:{…}, events[], coverage, notes[], errors?}`. **No `context` and no difference field** (tested) | ≤ 50 KB, ≤ 300 ms (10k fixture) |
| `GET /api/proposals?…&week=&source=&class=&fields=summary` | List and drill-down projection (no `content`) | adds `revertable`, `decider` | ≤ 30 KB at a 200 cap |
| `GET /api/search/misses?since=30d` | Misses | `{repeat:[{query,days,lastSeen}], recent:[…], total}` | ≤ 10 KB |
| `GET /api/asset/improve?ref=` | V-18 | `{proposals:[summary], weeklyAppearances:[{start,n}]}` | ≤ 5 KB |
| `POST /api/proposals/:id/revert` | Undo / Revert | `assertWriteLeaseFree("ui-proposal-revert")`, then `akmProposalRevert({id})` (`commands/proposal/proposal.ts:476`). Errors: `PROPOSAL_NOT_REVERTABLE`, `PROPOSAL_NOT_ACCEPTED`, lease, stale | — |
| `POST /api/proposals/:id/reopen` | Reopen | `assertWriteLeaseFree`, then `akmProposalReopen({ids:[id]})` (`proposal.ts:323`), all-or-nothing | — |
| `POST /api/proposals/reject` | Batch reject | one `assertWriteLeaseFree`, then `akmProposalReject` per id in order. **Not atomic**; returns per-id `{id, ok, code?}` (≤ 200 ids, reason ≤ 2,000) | — |

**Write routes**
- `matchWriteRoute` gains the kinds `revert`, `reopen` and `reject-many`, with the regex `/(accept|reject|revert|reopen)$/`.
- They keep the header-token, `Origin` and JSON checks and the body limits.
- They call the CLI-level `akmProposal*` functions (contract at `commands/ui/proposal-actions.ts:1-13`).
- **Auth tests for every new route:** 401 without the header token, and 401 with only `?token=` (after B-49).

### 8.5 Budgets (D-52)

| Budget | Target | Today | Enforced by |
|---|---|---|---|
| Authored JS + CSS | Σ per-file gzip-9 ≤ **95 KB** (was 85 KB: the review, impact, Misses and asset-rail pages are in; the layered CSS is seven files, each gzipped alone); CSS ≤ **14 KB**; page module ≤ 8 KB | 51.9 KB / 5.1 KB | `tests/ui-asset-budget.test.ts` (P0-5) |
| ECharts | ≤ **200 KB** gzip-9 (≈ 198 with Tooltip) | 189.4 KB | same |
| ECharts on Overview first paint | not requested before a chart card intersects | eager | Playwright network log |
| API sizes and times | per §8.4 | — | integration tests: the median of 5 runs after 1 warm-up; over budget warns, over 2× fails. The 10k fixture is built by direct SQL in one transaction (`tests/_helpers/ui-volume-fixture.ts`) |
| Layout stability | CLS ≤ 0.05 on Overview and Improve | full-page spinner | Playwright `layout-shift` observer |

**Caching**
- Static files use a strong `ETag` and `no-cache`. `/api/` stays `no-store`.
- A memo for `impact`, keyed by `(route, query, state.db mtime)`, is added only if the budget is missed.
- On Reload, the previous content stays, dimmed (`aria-busy`).

### 8.6 Testing

| Layer | What | Where |
|---|---|---|
| Unit | `stats.ts`, `derive.ts` (every branch incl. low-n, Laney, binomial, staged class, the V-04 invariant, mature window, eligibility); `components.js` markup; `*Href` hostile input; `richSafe`; `sparkline` nulls; every `summary()` and `table()`; pulse tile name | `tests/ui-derive.test.ts`, `tests/ui-stats.test.ts`, `tests/ui-components.test.ts` |
| Parity | UI vs CLI metrics (D-54) | `tests/ui-metrics-parity.test.ts` |
| Integration | Each route: shape, caps, planted secrets redacted, read-only, 10k budget, auth (401s); write routes | `tests/integration/ui/ui-server.test.ts` |
| Page render | Each page's `describe` block runs real API data through the module (existing pattern) | `tests/integration/ui/ui-client.test.ts` |
| Source scans | §8.8 [S] items, as a ratchet | `ui-client.test.ts` scan block |
| ECharts SSR | Each builder: series, axes, `minInterval`, null gaps, hollow below n, in-progress absent, no label `position:'inside'`, decal pattern, hostile labels | `tests/ui-charts-ssr.test.ts` |
| Visual | §8.7 | `tests/visual/*.pw.ts` |
| a11y | axe (ratchet), reflow at 320/640, text spacing, targets, focus-after-route and during async, `#route-status` once, 2.4.11 focus not obscured, aria snapshots (`toMatchAriaSnapshot`), contrast/forced-colors/reduced-motion emulation | `tests/visual/a11y.pw.ts` |
| Tokens | §7.1 assertions | `tests/ui-tokens-contrast.test.ts` |
| CSS lint | §8.1 | `scripts/lint-ui-css.ts`, `tests/lint-ui-css.test.ts` |

**Tests that changes will break, named in their tasks:**
- `ui-client.test.ts:109` reads `styles.css` by name (P2-1b).
- The `Ctx` type at `ui-client.test.ts:160-165` (P2-9b).
- The embedded map at `:91-94` and import resolution at `:96-101` (P0-4, P3-1).
- The licence banner check at `:70-72` (P2-6b).

### 8.7 Deterministic visual harness (P0-1a/b)

**Config**
- `@playwright/test` is pinned exactly (Q-05), with a `pinNotes` entry giving the image tag.
- `tests/visual/playwright.config.ts`:
  - Chromium only, `deviceScaleFactor:1`, `timezoneId:'UTC'`, `locale:'en-US'`, `colorScheme` per project, `reducedMotion:'reduce'`;
  - `expect.toHaveScreenshot({maxDiffPixels:0, threshold:0.1, animations:'disabled', caret:'hide'})` (D-37);
  - `testMatch:'**/*.pw.ts'`, a suffix bun never collects;
  - `webServer:{command:'bun tests/visual/serve.ts', port:9391, reuseExistingServer:!process.env.CI}`.

**`tests/visual/serve.ts`**
- Calls `setSystemTime(new Date(FIXED_NOW))` from `bun:test` first. `FIXED_NOW='2026-06-17T14:20:00Z'`, a Wednesday (Q-06).
- Builds an isolated sandbox in a temp dir, with AKM_*/XDG_* env as `tests/_helpers/sandbox.ts` does.
- Runs `tests/visual/seed.ts` (Appendix C). It writes **every** timestamp explicitly: `usage_events.created_at` (whose default is SQLite `datetime('now')`, `indexer/usage/usage-events.ts:85`), `events.ts`, proposal times, improve runs, task history, and git commits with `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`.
- Writes a config with probes and network checks off.
- Calls `startUiServer({port:9391, token:'visual-token'})`.
- Specs open `/?token=visual-token` and call `page.clock.setFixedTime(FIXED_NOW)`.

**Masks.** `[data-volatile]` covers version, host, port and host-dependent check evidence.

**Gallery and reference screens**
- They live in `tests/visual/` and are served through `page.route('**/__gallery*')` on the UI origin, so CSP holds.
- They import `/components.js` from the live server.
- No non-UI file is added to `src/assets/ui/`.

**CI** (`.github/workflows/ui-visual.yml`, separate from `ci.yml`)
- Runs on every PR, with no `paths` filter. The first step exits 0 when `git diff --name-only origin/main...` matches nothing under `src/assets/ui/** src/commands/ui/** src/commands/metrics/** tests/visual/** package.json bun.lock`.
- Container `mcr.microsoft.com/playwright:<tag>` pinned by digest. Actions are SHA-pinned.
- Uploads the HTML report and the `actual`/`diff` PNGs on every run.
- Target time ≤ 10 min (Q-07).
- Starts as not required. **P0-1c** makes it required after 5 consecutive green runs on main (an owner action, Q-08).

**Scripts:** `test:ui-visual`, and `test:ui-visual:docker` (the same command in the pinned image).

**Baseline updates**
- Only CI or the docker script produces baselines.
- To accept intended diffs: `gh run download <id> -n ui-visual-actual`, copy the files over `__screenshots__`, and commit only the PNGs of the intended diffs, with the intent listed per file in the PR body.
- Never run `--update-snapshots` outside the pinned image.
- Two open PRs may not change baselines of the same route at once.
- Bump Playwright alone, in a PR that changes only baselines.

**Flake budget.** If a spec needs a retry more than once in 20 runs, the next UI PR masks or fixes that region before anything else merges.

### 8.8 Final enforceable checklist (modern CSS, clean code, quality gates)

Each item names its enforcement:
- **[B]** Biome
- **[L]** `lint-ui-css.ts`
- **[S]** source scan
- **[U]** unit or integration test
- **[P]** Playwright
- **[R]** reviewer

Each child issue lists the S-numbers that apply.

**CSS (modern, low specificity)**
- S-01 Tokens only for colour, space, radius, font size, shadow, z-index and duration. System colours, `transparent` and `currentColor` are allowed. [L]
- S-02 A token exists only with a consumer. [L]
- S-03 One top-level rule per class; variants (states, `@container`, forced colors, contrast, print) nest inside. [L][B]
- S-04 Specificity ≤ (0,3,0); nesting ≤ 2; no IDs; no type-qualified classes; base rules in `:where()`. [L]
- S-05 Logical properties only. [L]
- S-06 `@media` only for the shell, motion, contrast, forced colors and print. `@container` lengths only 30/60/56rem. [L]
- S-07 `!important` only in the reduced-motion block. [B][L]
- S-08 No descending specificity, duplicate properties, shorthand overrides or unknown properties. [B]
- S-09 `dvh`, not `vh`. `clamp()` only in the three named tokens. Colours in `light-dark()` tokens only. [L]
- S-10 State comes from ARIA/`data-*` attributes; no state classes. [L]
- S-11 `box-shadow` only on floating surfaces. No nested cards. `letter-spacing` only in the nav section header. Blocks in alphabetical order. [L][R]
- S-12 `:focus-visible` ring per §7.0 and nothing else. Reduced motion respected. Forced-colors variant present on every component. [P][R]

**JS and markup (clean code, safety)**
- S-13 `innerHTML` only in `mount`. None of `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval`, `new Function`, inline handlers, `confirm`/`alert`/`prompt`, off-host URLs. [S]
- S-14 No `style="` except `style="--<name>:`. [S]
- S-15 Storage only through `lib.js` `prefs`; the token only in `sessionStorage`. [S][P]
- S-16 `window`/`document` listeners only in `app.js` and `shortcuts.js`. [S]
- S-17 No top-level `let`/`var` in page modules. Pages use `ctx.api`. [S]
- S-18 Hash URLs only from `*Href` builders, tested with hostile input. [U]
- S-19 ECharts `aria.enabled:true`, `label.enabled:false`, richText tooltip, `richSafe`. The hostile-label SSR test passes. [U]
- S-20 Every chart follows the R9 markup and has a tested low-n branch. [U][P][R]
- S-21 Builders land with a consumer and a gallery entry; exports alphabetical. [R][P]
- S-22 Pages render controls only through builders (ratchet). One primary per view. [S][U]
- S-23 No dead, commented-out or speculative code. No unused exports. Functions do one thing. Names say what a thing is. Diffs are surgical: no unrelated hunks. [R][B]
- S-24 No `bun:test` imports under `src/`. Emoji and forbidden words absent from UI strings. [S]

**Server**
- S-25 New GETs: read-only DB access, `section()`, their own module, `ROUTES` alphabetical, `ui-api.md`, `Server-Timing`. The read-only test covers every `ROUTES` key. [U]
- S-26 Writes go through `matchWriteRoute`, `assertWriteLeaseFree` and the `akmProposal*` CLI functions. [U][R]
- S-27 Free text passes `redactCredentialPatterns` + `scrubUrlCredentials`, capped at 280; lists capped with `total`. [U]
- S-28 Header-only token on `/api/`; 401 tests; CSP string pinned. [U]
- S-29 Persisted-field changes update `docs/architecture/persisted-data-compat.md` and the validator tests. Migrations are flagged in the PR title. [R][U]

**Quality gates**
- S-30 axe has 0 new violations beyond the ratchet. Reflow 320/640, text spacing, targets ≥ 24px, focus never on `body`, one route message, 2.4.11. [P]
- S-31 Zero unexplained pixel diffs; 0-diff PRs change 0 pixels. The computed-style audit (§11.5.2) reports 0 off-token values on new pages. [P][R]
- S-32 Budgets per §8.5. [U][P]
- S-33 UI and CLI parity on shared metrics. Copy follows the verbs and glossary; forbidden-word scan passes. [U][S][R]

---
## 9. Bugs to fix first

**Severity**
- **Critical**: misleads about state, or blocks a top job.
- **High**: a reader draws a wrong conclusion, or an S1 accessibility blocker.
- **Medium**: a WCAG AA failure with a workaround, or a visible bug.
- **Low**: polish or hygiene.

**Source** names the review finding. "✔" means the finding was re-verified in code on 2026-11-01.

Every bug fix PR starts with a failing test that reproduces the bug (`AGENTS.md:23`): a unit or integration test, or a visual or a11y assertion. The "Task" column names the child issue that owns the fix (§12).

| ID | Sev | Defect | File:line | Source | Fix | Task |
|---|---|---|---|---|---|---|
| B-01 | **Critical** | Command assets render "This asset has no body." The API sends `template`; the page reads only `content` (also for "Markdown source") | `assets/ui/asset.js:76,133` ✔ | UX F1 | Body = first non-empty of `content`, `template` (and any other body field `/api/asset` returns per type). The integration test uses a command asset | P1-1 |
| B-02 | **Critical** | Bundles says "No bundles are configured. Run akm init…" above an index of 251 entries. The working stash is not listed, and `akm init` is not a top-level command (`cli.ts:251` is only a `--no-init` flag) | `assets/ui/bundles.js:148` ✔ | UX F2 | List the working stash first; new empty-state copy (§4.7) | P1-1 |
| B-03 | Medium | `.check` is defined twice. The health-check `li.check` inherits the form-label flex layout, so evidence sits beside the message and the indent breaks | `assets/ui/styles.css:621,1131` ✔; `overview.js:29`; `bundles.js:152` | FE F1 | Rename the label to `.check-label`; lint rule 3 | P1-3 |
| B-04 | **High** | The "Pending proposals" tile counts pending rows whose `updated_at` is in the window, across all stashes. At 24h a queue of 40 three-day-old proposals shows 0, and it disagrees with the Proposals page | `storage/repositories/metrics-repository.ts:114-124` ✔ → `commands/metrics/metrics-cli.ts:225` → `assets/ui/overview.js:72` | DA F1 | Stash-scoped, unwindowed pending count, labelled "Waiting for review (now)"; interim until P3-2 removes the tile row (D-27) | P1-4a |
| B-05 | **High** | Daily charts drop empty days. The category axis compresses gaps; the latency line bridges holes | `commands/metrics/collect.ts:231-237,342`; `commands/ui/metrics.ts:11-40`; `assets/ui/overview-charts.js:17-26,117-150` | DA F2, A11Y O6 | Zero-fill counts **only inside [dataStart, until)**, null rates and medians (§5.0 R1) | P1-5 |
| B-06 | Medium-High | "Selects per search" divides all-source selects by user searches with hits | `assets/ui/overview.js:78` ✔; `commands/metrics/metrics-cli.ts:173-175,220` | DA F4 | Replace with M-06 in the table, labelled "(all sources)" | P1-4b |
| B-07 | Medium | "Shows … N distinct assets" counts assets with *any* use, including per-hit search rows | `assets/ui/overview.js:76` ✔; `commands/metrics/collect.ts:239-247` | DA F5 | Relabel "assets with any recorded use", or drop it | P1-4b |
| B-08 | **High** | The accept-rate table is all-time under the window header. It drops reverts, pools judge with human decisions, and shows "100%" at 1 of 1 | `assets/ui/overview.js:83` ✔; `commands/health/accept-rate.ts:49-84` | DA F3 | Remove it from Overview (D-17); V-10 replaces it | P1-4b |
| B-09 | Medium | The partial first day and partial today look like dips, and the window header drops times | `assets/ui/overview.js:67-68`; `commands/metrics/collect.ts:233` | DA F6 | Mark partial bins per §5.0 R2; header with times; `dataStart` per store | P1-5 |
| B-10 | Low | The median-search tile and the chart use different filters (`finite` vs `≥ 0`), and the tile has no n | `commands/metrics/collect.ts:275` vs `commands/ui/metrics.ts:18` | DA F13 | One filter (`≥ 0`), show n | P1-4a |
| B-11 | Medium | The task-failure chart ranks by count and hides never-failed tasks; the tile has no rate | `commands/ui/api.ts:218-228`; `assets/ui/overview-charts.js:200-210,235-238` | DA F8 | Rank by rate with n (M-25) | P1-4a (rank) / P1-4b (display) |
| B-12 | Medium | Partial token coverage is drawn at full height. The empty aggregate renders "Tokens cover - / 0 calls" | `assets/ui/overview-charts.js:6,79-82,90`; `assets/ui/lib.js:129-131` | DA F10, A11Y O4 | Hollow bar under 80% coverage with a per-bar note; "No model calls in this window." **[uncertain why `usageCalls` is missing on the empty aggregate; the test must pin it]** | P1-4b |
| B-13 | Low | The daily feedback count includes unsigned rows; the tile counts signed rows only | `commands/metrics/collect.ts:303-309` vs `:361-369` | DA F12 | Count signed rows only in both | P1-4a |
| B-14 | Medium | The improve-run scatter uses a category axis of timestamps, shows the "latest 10, all time" in a windowed page, and uses ms for runs that take minutes | `assets/ui/overview-charts.js:211-233`; `commands/ui/api.ts:73` | DA F9 | Replace with the V-09 strip; the run table uses minutes and honours the window | P5-3 (interim in P1-4b: retitle "Latest 10 runs (all time)", minutes) |
| B-15 | Medium | A no-op proposal is offered with Accept as the primary action, which leads to "No commit was recorded" | `assets/ui/proposals.js:237-238` ✔ | UX F9 | No-op banner; "Reject as no-op" becomes the primary | P1-6 |
| B-16 | Medium | Every health group, including Failing, is collapsed by default, and health is the last section | `assets/ui/overview.js:20-25` ✔ | UX F3, A11Y O3 | Failing and Warnings open; Needs attention at the top (P3-2) | P1-4b |
| B-17 | Medium | "PASS" shows while 4 checks are unknown, next to a 30d selector, while health is 24h | `assets/ui/overview.js:47-57,100`; `commands/ui/api.ts:189-199` | UX F5, DA F14 | "Healthy · 4 checks could not run"; "Health: last 24 hours" in the strip | P1-4b |
| B-18 | Medium | Form-control borders are 1.31:1 (light) and 1.36:1 (dark): they fail WCAG 1.4.11 | `assets/ui/styles.css:1096-1106,1431-1436` | FE F3, A11Y C1 | `--border-strong` (#7d8695 / #68758a, ≥ 3.2:1) on inputs, selects, textareas, secondary buttons | P1-3 |
| B-19 | **High** (S1) | `<main id="app" aria-live="polite">` announces whole pages on every route | `assets/ui/index.html:28` ✔; `assets/ui/app.js:92,104` | FE F2, A11Y G1 | Remove it; add `#route-status` | P1-2 |
| B-20 | Medium | There is no skip link: 8 tab stops before content | `assets/ui/index.html:12-25` | A11Y G3, UX F23 | Skip link | P1-2 |
| B-21 | **High** (S1) | No focus management on route change: focus falls to `<body>` | `assets/ui/app.js:110-116` | A11Y G2 | Focus `h1` or restore (§8.2 rule 10) | P1-2 |
| B-22 | Medium | The Overview window `<select>` navigates on `change`, so focus is lost | `assets/ui/overview.js:91-95` ✔ | A11Y G4 | Interim: restore focus by `name` as Search does (P1-2). P3-2 removes the select (30d fixed); P5-3 adds the segmented control that redraws in place | P1-2 |
| B-23 | Medium | The Search browse group `summary` overflows by 55 px at 320 px (145 px with text-spacing) | `assets/ui/search.js:81` ✔ | A11Y G9 | `overflow-wrap:anywhere` on the summary | P1-3 |
| B-24 | Medium | `<summary>` targets are 23.3 px and stacked with no gap (fails 2.5.8 on Asset) | global `summary`; axe | A11Y T1/A4 | `summary{min-block-size:var(--target-min);padding-block:var(--space-1)}` | P1-3 |
| B-25 | Medium | "select all in this group" repeats with an identical name | `assets/ui/proposals.js:71` | A11Y P1 | "Select all 2 reflect proposals" | P1-6 |
| B-26 | Medium | Selected states (current nav, active chip, pressed diff toggle) are colour only, and vanish in forced colors | `assets/ui/styles.css:~196,983,1202` | A11Y C2 | Non-colour cue + forced-colors block | P1-9 |
| B-27 | Medium | Focus drops to `<body>` while "Accepting…", and during batch accept | `assets/ui/proposal-actions.js:65-67,99-100,256-259` | A11Y D1/P3 | `aria-disabled` in place, then focus the result | P1-6 |
| B-28 | Low | Esc does not cancel a confirm or reject step | `assets/ui/proposal-actions.js` | A11Y D3 | Esc cancels and refocuses the opener | P1-6 |
| B-29 | Low | The mobile menu does not close on Esc or return focus; Refresh is hidden in it | `assets/ui/app.js:169-179` | A11Y G10 | APG disclosure behaviour | P1-2 |
| B-30 | Low | The unsaved guard sits outside landmarks, with no Esc | `assets/ui/index.html:27`; `assets/ui/app.js:66-76` | A11Y G5 | Labelled region; Esc = Keep editing | P3-10 |
| B-31 | Low | Document titles are generic ("Proposals - akm ui") | `assets/ui/app.js:90` | A11Y G7 | Specific titles (§3.2) | P1-2 |
| B-32 | Low | Breakpoints 800/799 px plus a JS `NARROW` disagree at 800 px | `assets/ui/styles.css:221,591,856,1317`; `assets/ui/diff-view.js:21` | FE F5 | One `50rem` breakpoint; container queries elsewhere | P1-3 |
| B-33 | Low | If ECharts fails to load, the chart silently disappears | `assets/ui/chart-view.js:56` ✔ | FE F6 | "Chart unavailable…" state | P2-6a |
| B-34 | Low | The Changes page groups by the committer's local date; everything else is UTC, and the page never says so | `commands/ui/git-read.ts:120,128`; `assets/ui/changes.js:10,28` | DA F15, A11Y B5 | Group by the UTC date; label it | P1-8 |
| B-35 | Low | A rejection and an "auto-rejected" gate get the red fail badge | `assets/ui/proposals.js:33,81-86` | DA F16, A11Y P5 | Neutral tone | P1-6 |
| B-36 | Low | The breadcrumb shows the raw 8-char id and is not a breadcrumb nav | `assets/ui/proposals.js:232` ✔ | A11Y D7 | `breadcrumb()` with the ref | P1-6 |
| B-37 | Low | The "untraced" config badge is unexplained and coloured warn | `assets/ui/config.js:9` | A11Y B4 | "source unknown", neutral | P1-8 |
| B-38 | Low | Search filter selects have no visible labels ("current", "50") | `assets/ui/search.js:68-75` | A11Y S1, UX F22 | Visible labels | P1-8 |
| B-39 | Medium | The search result count is not announced (it relied on B-19) | `assets/ui/search.js` | A11Y S2 | `#route-status` message | P1-2 |
| B-40 | Medium | `pre.code` blocks are not keyboard-scrollable in Firefox and Safari (axe ×45) | `assets/ui/markdown.js:98` ✔; asset source and evidence `<pre>` | A11Y A1 | `tabindex=0 role=region aria-label` | P1-8 |
| B-41 | Low | Duplicate heading: H1 title plus Markdown `# Title` | `assets/ui/asset.js:120` | A11Y A2 | Drop a matching leading H1 from the body | P1-8 |
| B-42 | Medium | The editor `role=status` text changes on every keystroke | `assets/ui/editor.js:154-160` | A11Y E1 | Announce on transition only | P1-8 |
| B-43 | Low | Ctrl/Cmd+S opens the browser's Save dialog | `assets/ui/editor.js` | A11Y E2 | `preventDefault` + `requestSubmit()` | P1-8 |
| B-44 | Low | The Preview toggle combines `aria-pressed` with a changing label | `assets/ui/editor.js:82-88` | A11Y E3 | Write/Preview tabs | P3-10 |
| B-45 | Low | The sidebar background stops at 100vh on long pages and print | `assets/ui/styles.css:146-158` | UX F24, FE C5 | Paint the column on `.shell`; `dvh` | P2-4 |
| B-46 | Low | Relative times expose the absolute time only in `title`, which keyboard users cannot reach | `assets/ui/lib.js:169` | A11Y P6 | Absolute time in the cell (sr or visible) | P1-6 |
| B-47 | **High** (for the dashboard) | `wireChart` redraws every chart on any `change` inside `<main>`; it depends on listener order; there is a synthetic `change` in proposals | `assets/ui/chart-view.js:58` ✔; `assets/ui/overview-charts.js:13`; `assets/ui/proposals.js:158` ✔ | FE J1/J2 | §8.3 | P2-6a (the synthetic change goes in P1-10) |
| B-48 | Medium | `/api/proposals` reads every proposal with `content` on every list request | `commands/ui/api.ts:415`; `storage/repositories/proposals-repository.ts:497-525` | FE P1 | Projection without `content`; status in SQL | P2-9a |
| B-49 | Low | GET `/api/*` accepts `?token=` (URL token leakage) | `commands/ui/server.ts:310` ✔ | FE S1 | Header only for `/api/` | P2-9a |
| B-50 | Low | Duplicate rules: `.notice` (`:445`/`:1483`), `button` (`:1096`/`:1163`), reduced-motion (`:439`/`:1568`), `.form-grid textarea` (`:1117`/`:1122`), `.document-body` (`:278`/`:328`); redundant `[hidden]` overrides; three swatch systems | `assets/ui/styles.css` as cited | FE C2/C3 | Merge in P1-3; swatches unified in P2-5b | P1-3 |
| B-51 | Low | `.sr-only` uses the deprecated `clip` and lacks margin, border and padding | `assets/ui/styles.css:1437-1444` | FE F8 | Modern pattern | P1-3 |
| B-52 | Low | There are no forced-colors styles: badges have transparent borders, and dots and swatches are backgrounds | `assets/ui/styles.css:476-528,1551`; `assets/ui/charts.js:28` | FE F9, A11Y C4 | §7.2 forced-colors block | P1-9 |
| B-53 | Low | The chart palette passes only `--s1..--s5` | `assets/ui/chart-view.js:24` ✔ vs `:31` | FE F7 | `SERIES` constant | P2-6a |
| B-54 | Low | `meta.readOnly` is read but never sent | `assets/ui/app.js:132`; `commands/ui/api.ts:129-143` | FE F4 | Remove the dead read | P1-2 |
| B-55 | Low | Decals are always on | `assets/ui/chart-view.js:26` ✔ | VIZ §6, FE J6, A11Y §3.1.5 | D-04 | P2-6a (with D-29) |
| B-56 | Low | Count axes show fractional ticks ("0.5 proposals") | `chart-view.js` `verticalBars`/`horizontalBars` | A11Y O5 | `minInterval:1` | P1-4b |
| B-57 | Medium | The reject-reason error is not associated with its field (no `aria-invalid` or `aria-describedby`), and `maxlength` truncates silently | `assets/ui/proposal-actions.js:70-71` | A11Y D2 | §4.3 reject flow | P1-6 |
| B-58 | Medium | The side-by-side diff reads pane by pane, and the signs are not spoken as words | `assets/ui/diff-view.js:73-96` | A11Y D5 | sr "Added:"/"Removed:"; `<mark>` word marks | P1-7 |
| B-59 | Medium | `.gap-btn` is 20 px high, exists only in the left pane, and focus goes to the region rather than the revealed line | `assets/ui/styles.css:1304`; `assets/ui/diff-view.js:197` | A11Y T2/D6 | ≥ 24 px; focus the first revealed row | P1-7 |
| B-60 | Low | Native checkboxes are 13×13 with no label hit area | proposals list, Activity toggles | A11Y T3 | ≥ 24 px label targets | P1-3 |
| B-61 | Medium | The batch bar renders after the list, its count is not announced, and there is no batch reject | `assets/ui/proposal-actions.js:158-188` | A11Y P2, UX F7 | Sticky selection region (P3-6) | P3-6 |
| B-62 | Low | Word-level diff highlights are colour only | `assets/ui/diff-view.js:53` | A11Y C3 | `<mark>` + underline | P1-7 |
| B-63 | Low | The focus ring is clipped inside `overflow` containers | `assets/ui/styles.css:1323` | A11Y C6 | `outline-offset:-2px` on focusable scrollers | P1-3 |
| B-64 | Low | Overview ships unused `pendingProposals` and `acceptRateBySource`; `zeroResultQueries` is uncapped | `commands/ui/api.ts:206-208`; `commands/ui/metrics.ts:41` | FE P2 | Trim and cap | P2-9a |
| B-65 | Low | Static files are sent `no-store`, so ECharts is re-downloaded on every reload | `commands/ui/server.ts:120-124,354-360` | FE P4 | ETag + `no-cache` | P2-9a |
| B-66 | Low | Changing the metrics window recomputes 24h health (161 ms) | `commands/ui/api.ts:188-245` | FE P3 | The client caches health; or split it | P2-9a |
| B-67 | Low | In-flight requests are not aborted on route change | `assets/ui/app.js:79-124` | FE J7 | `ctx.signal` | P2-9b |
| B-68 | Low-Med | "User-attributed activity" also labels LLM calls, task runs, proposals, index builds and selects, which are not user-filtered | `assets/ui/overview.js:100` ✔ | DA F11 | Per-card source note | P1-4b |
| B-69 | Medium | Retrieval shows counts where a rate matters (1 of 2 failing looks better than 2 of 30) | `assets/ui/overview-charts.js:117-131` | DA F7 | A no-result rate column with n (interim); V-05 later | P1-5 |
| B-70 | Low | The median-latency point is an unlabeled 7 px dot, invisible with one sample | `assets/ui/overview-charts.js:147` | A11Y O7 | R10: fewer than 3 bins gives a stat | P1-5 |
| B-71 | Low | The age backlog uses categorical hues for an ordinal scale; on mobile it takes 780 px before the queue | `assets/ui/proposals.js:115-135` | A11Y P4, UX F11 | D-13 | P1-10 |
| B-72 | Low | The editor "Cancel" is a 49×23 bare link among buttons | `assets/ui/editor.js:165` | A11Y T4 | `.btn-secondary` link | P1-8 |
| B-73 | Low | The New-knowledge `Name` field has no format hint, and its errors are not tied to the field | `assets/ui/editor.js:52` | A11Y E5 | §4.9 | P3-10 |
| B-74 | Low | The editor load error is a dead end ("Refresh the index…", code `INVALID_FLAG_VALUE`) **[uncertain: may come from the reviewer's sandbox copy]** | `assets/ui/editor.js` | UX F20 | Actions "Rebuild index" and "Open read-only" | P3-10 |
| B-75 | Polish | The version is shown twice; Bundles has no subtitle; long absolute paths | `assets/ui/overview.js:56`; `assets/ui/bundles.js:142` | UX F27 | Version in the sidebar only; subtitle; `pathText` | P3-1, P3-9 |
| B-76 | Low | Search shows `score 0.016` (identical to 3 decimals) and "Matched: lexical rank N" as the only explanation | `assets/ui/search.js:18,21` | UX F12 | Highlight and "Matched in"; score in details | P3-7 |
| B-77 | Low | `#/asset/<ref>` silently shows "No asset selected" | `assets/ui/app.js:48-58`; `assets/ui/asset.js:67` | UX F17 | Path param plus redirect | P3-1 |

**Fix first** (Critical and High): B-01, B-02, B-04, B-05, B-08, B-19, B-21, B-47 (before any new chart), B-06.

**Interim fixes** in Phase 1 run on today's architecture. Phase 2–5 tasks may replace the code, but they must keep each bug's reproducing test green.

---
## 10. Data gaps, smallest first

**State-migration summary.** **Only G7 needs a state.db migration, and it is in P6.**
- G2 and G3 are persisted proposal-metadata changes. They need no migration, but each needs a compat-doc update and a validator test.
- G4, G9 and G10 are event-metadata additions.
- G10's select dedupe changes counts from its ship date, so the coverage panel says "selects deduped from <date>".

| # | Change | Size | Migration? | Unlocks | Task |
|---|---|---|---|---|---|
| G1-a | Read `rankPosition`/`query` from select metadata (`storage/repositories/metrics-repository.ts:77-85` selects only `ts, ref`), and `resultRefs`/`mode` from `search` events | server | no | M-06, V-15 top-5 | P4-3, P4-5 |
| G1-b | Aggregation routes and the `/api/proposals` filters | server | no | V-01…V-19 | P4-* |
| G1-c | Per-asset windowed join (V-15), including curate per-hit rows | server | no | V-15 | P4-5 |
| G4 | `totalEntries` and counts by type on `index_completed` metadata (`indexer/indexer.ts:823-840`) | a few lines | no | M-11, the library-size series | P4-8a |
| G2 | A top-level proposal metadata field **`acceptedAt`** (ISO). It is written by `promoteProposal` at accept and never overwritten by revert. It is added to the decoder (`storage/repositories/proposals-repository.ts:369`), the serializer (`:434`) and `validatePresentMetadata` (`:151`). **Not in `reviewHistory`**: `isReviewHistoryEntry` requires `reopenedAt` (`:140-147`), and a failing row is skipped from every list (`:175-180`). Known loss: an older binary that rewrites the row drops `acceptedAt`, and readers then fall back to the `promoted` event | one field | no (compat doc + validator test) | accept dates past 90 d; M-19, M-20 | P4-8b |
| G3 | `review.decidedBy?: 'triage'\|'human'` through a `decidedBy` option on `akmProposalAccept`/`akmProposalReject` (default `'human'`); `drain.ts` passes `'triage'` (it calls them at `commands/proposal/drain.ts:53,548`). `proposal-actions.ts` does not change. Only later decisions carry it | one field | no (compat doc + validator test) | the M-15 decider | P4-8c |
| G10 | `source` and `searchId` on `search`/`select` events (`commands/read/search.ts:370-373`, `indexer/usage/show-usage.ts:44-71`); selects deduped per (searchId, ref). Old rows are treated as "all sources" | small, CLI hot path | no | M-06 line, M-08, M-33, source-attributed V-15 | P4-9 |
| G5 | `runId` in `llm_usage` event **metadata** (`llm/usage-telemetry.ts:38-62`). `events.correlation_id` does **not** exist (`core/state/migrations.ts:86` is a comment) | small | no | exact cost per run | P6-6 |
| G9 | A `config_changed` event (key names only) for `improve.*`, `search.*`, `experimental.*` | small | no | config marks | P6-6 |
| G6 | Configurable usage retention (`indexer/usage/usage-events.ts:213`) | small; privacy | no | 180-day raw windows | P6-5b (Q-02) |
| G7 | A **query-free daily rollup**: per UTC day, `searches`, `foundNothing` (after the repeat merge), `signedPos`, `signedNeg`, `curateEmpty`, and selects by source (after G10), so that it reproduces M-02/M-09 exactly | medium | **yes** | p-chart baselines beyond 12 weeks | P6-5a (Q-01) |
| G8 | The expected schedule per task | medium | no **[uncertain where the schedule lives]** | missed-run detection | P6-7 (Q-13) |

**Purge alignment.**
- `usage_events` is purged on `akm index` (`indexer/indexer.ts:1869`).
- `events` **and** `improve_runs` are purged on `akm improve` (`commands/improve/loop-stages.ts:738-755`).
- So `dataStart` is computed per store from its earliest row (§5.0 R1).

---

## 11. Design review process

### 11.1 Gates and sign-off

| Gate | When | Signs | Veto | Human | Artefacts | Pass |
|---|---|---|---|---|---|---|
| **R0 Baselines** | After P0-1b and P0-2 | VD, AX | — | The owner glances at the contact sheet (async) | The full current matrix; the axe report; known defects tagged against §9 | Every §9 visual bug is visible and tagged. Masks are in place. Two runs give 0 diff |
| **R1 Spec** (no code) | Before the first PR of any new page, component or chart | VD (owns the spec), AX; DV for charts | AX on a11y, DV on data honesty | No | **A comment on the issue**: purpose and job; an ASCII or low-fi wireframe at 1440 and 390, citing the reference screen; all six states; the keyboard map; microcopy; the filled §5 entry for charts; the page's colour map (R7) | Every rubric dimension ≥ 4 on the spec. No open Blocking comment. Turnaround: 1 business day |
| **P2-11 Reference screens** | Once, before P3-2 | VD proposes | — | **Owner approves** (Q-09) | Static reference pages for Overview, Proposals, Improve and Asset at 1440 and 390, light and dark | Owner approval. They become the conformance target |
| **R2a First light** | A draft PR within about 150 lines of a new surface | VD, DV | — | No | Real render on seeded data; CI screenshots | "Proceed" or "rethink" (no score) |
| **R2 PR** | Every PR with a non-empty pixel diff, or any change to `src/assets/ui/**` (D-45) | VD; AX if markup, focus or ARIA changed; DV if a chart or metric changed | as above; VD on consistency against the gallery and reference | No | §11.5.2 artefacts; the §11.4 checklists in the PR body | §11.5.3 completed with no Blocking items. No rubric dimension < 3. Automated gates green. 0-diff PRs change 0 pixels |
| **R3 Page** | The last PR of each page (§12) | VD, AX, DV | as above | **Owner approves.** The owner or a delegate does a screen-reader pass for Proposals and Improve (Q-10) and a macOS/Windows spot check of Overview and Proposals (D-38) | All states × widths × schemes + forced colors; keyboard trace JSON for the page's §2 jobs; aria snapshots; `Server-Timing` and client timings; reference vs actual side by side | Mean ≥ 4.0, no dimension < 3.5 (D-49). Each actual/reference difference explained or fixed. §2 step counts met. Budgets met |
| **R4 Final** | After P5-9 | all | as above | **Owner approves** | A contact sheet of every route × state × width × scheme; the token-usage report; a copy audit; before/after against R0 | Mean ≥ 4.2, no dimension < 4.0. Every ratchet list is empty. No open Critical or High bug |

**Conflicts.** When reviewers disagree with each other or with the spec, the implementing agent does not choose. It writes a "Conflict / options / recommendation" note in the PR. The VD lead decides. If the conflict touches §1.4 or §0, the owner decides, and the decision is appended to §0.

### 11.2 Screenshot matrix

The matrix covers meaningful route × state pairs only: about 140 shots (SA cut).

**Routes**
- overview
- proposals pending
- proposals recent
- proposal detail: edit, create, retire, no-op
- improve
- history
- search: results, browse, misses
- asset: knowledge, command
- edit
- new
- bundles
- config

**States per route:** loaded (seed); empty (fresh sandbox); low-data (1 active day, 6 searches); error (`page.route` → 500 on the main API); partial error; loading (a delayed route). Plus the **long-content fixture**: an 80-char ref, a 120-char query, a 6-digit count and a 40-segment path.

**Interaction states:** health open; mobile menu; split view with detail; status bar after accept; reject chips; selection bar; shortcut dialog; detail panel; unsaved guard; diff inline and side-by-side.

**Widths**
- 1440×900 and 390×844 everywhere.
- **1280×800**, light, for Overview, Proposals split and Improve (the `wide` edge).
- 320 for the reflow assertion only.

**Schemes**
- Light and dark.
- Forced colors and `prefers-contrast: more` for the gallery, Overview and Proposal detail. Improve is added at R3.

**Naming:** `tests/visual/__screenshots__/<route>--<state>--<width>--<scheme>.png`.

### 11.3 Anchored rubric (score 1–5)

- Each score needs **one sentence of evidence citing a screenshot file name**; a score without evidence is invalid.
- A dimension's score is the mean across the reviewers who scored it.
- The objective check must pass before a score of 4 or more is allowed.

| Dimension | 1 | 3 | 5 | Objective check (required for ≥ 4) |
|---|---|---|---|---|
| Clarity | Numbers without unit, window or n | Most numbers labelled | Every number states what, the window and n | Copy audit: every stat has a window chip in its region |
| Hierarchy | Main job below the fold; several primaries | Main job visible, but secondary content competes | Main job above the fold at 1440×900; exactly one primary; attention before trends | Playwright: the main-job region top < 900; primary count = 1 |
| Consistency | Page-local styles; new-looking controls | Tokens used, but ≥ 1 control differs from the gallery | Every control is a gallery component; spacing follows the rhythm table | Computed-style audit: 0 off-token values |
| Feedback and states | Blank areas; focus lost | All states exist, but some are generic | All six states designed; focus never lost; each action reports its result in place | Focus assertions; state strip captured; CLS ≤ 0.05 |
| Efficiency | Needless confirms; no keyboard path | Targets met by mouse only | §2 step counts met; keys work; confirms only for the irreversible | The keyboard trace meets the §2 counts |
| Learnability | Jargon without explanation | Some terms explained | Every glossary term explained at first use; empty states teach the next action | Scan: each glossary key on the page has a `term()` |
| Aesthetics | Misaligned, cramped or decorative | Aligned, but density is uneven | Calm: shared edges, one radius family, colour only for data, status and accent; no nested cards | Grid overlay shows shared edges; `.card .card` count = 0 |
| Accessibility | Keyboard or screen-reader blockers | AA with workarounds | WCAG 2.2 AA; forced colors usable; the table equivalent is complete | axe 0; 2.4.11; aria snapshot reviewed |
| Data honesty (charts) | Rates below min-n drawn; causal words | min-n respected, but the tier or partial bins are missing | All of §5.0 R1–R12 | SSR low-n tests pass; forbidden-word scan 0; no difference field in Linked payloads |

### 11.4 Per-PR checklists (paste into the PR body)

**General (every UI PR)**
```
[ ] Visual: before/after/diff attached (1440/390, 1280 where listed; light/dark; forced-colors where listed); every diff region mapped to an intended change
[ ] Conformance (page PRs from P3 on): reference | actual side-by-side attached; each divergence explained
[ ] axe: 0 new violations (light/dark, 1280/320); reflow at 320 and 640; text spacing passes
[ ] Targets ≥ 24px; focus never on <body> after route change or async action; one #route-status message per route
[ ] 2.4.11: Tab with the sticky bars and sticky thead visible; the focused element is never fully hidden
[ ] Zoom 200%/400% on touched pages: no overlap; tooltip inside the viewport
[ ] prefers-reduced-motion: no transition > 0 ms (computed-style assertion)
[ ] Aria snapshot updated and its diff explained if semantics changed
[ ] Checklist §8.8 items listed in the issue: all pass (lint, scans, tests)
[ ] Copy: verbs, glossary terms, window chips, UTC; no forbidden words or emoji
[ ] Budgets unchanged or within §8.5 (asset KB delta stated)
[ ] Low-data and empty fixtures render the designed branch of every touched region
```

**Chart (every PR that adds or changes a chart; DV and AX review)**
```
[ ] [A] Metric implemented once (stats.ts / derive.ts) and matches its §6 row incl. source='user' and dedupe; the test names the M-id
[ ] [A] Bins per R1 from dataStart; zero-fill only inside coverage; rates and medians null at n=0 (4-active-day and mid-window-start fixtures)
[ ] [A] In-progress absent from rate series; outline bar "so far" on counts; below-min hollow with no segments; < 3 bins → stat
[ ] [A] p-chart: fixed centre, binomial limits, Laney branch, band only with ≥ 4 baseline points, signals only after the baseline
[ ] [A] n on every rate; Wilson only in tables and non-p-chart rates; minInterval 1; category axes; no dual axes; no label inside marks
[ ] [A] No difference or effect field in any Linked payload
[ ] [A] R9 markup: figure, h2, takeaway, tier · window, role=img, aria-labelledby/describedby, SVG aria-hidden; table with caption and th scope; every drill-down reachable from table buttons
[ ] [A] Tooltip: richText, enterable, Esc hides, transitionDuration 0; nothing exists only in the tooltip
[ ] [A] Tokens: series ≥ 3:1 on surface; band edges ≥ 3:1; age ramp ordinal; validate_palette run on the chart's hue set in both schemes (output pasted)
[ ] [A] Forced-colors and more-contrast screenshots: marks, legend, band edges, selection visible; decals on
[ ] [M] Tier and window chip correct; takeaway true on seeded, low-data and empty fixtures (DV reads all three)
[ ] [M] Colour follows the entity; ≤ 4 hues; no s2 with s5; marks only from §7.6
[ ] [M] Harm never on a gain chart; flags shown with base rate and eligibility
```

### 11.5 Visual-review protocol

#### 11.5.1 Roles

| Role | Mandate |
|---|---|
| **VD** | Owns the spec and visual consistency. Can veto on consistency with the gallery and reference screens |
| **AX** | Can veto on accessibility |
| **DV** | Can veto on data honesty |
| **CD** | Copy. Folded into VD unless the owner assigns one |
| Implementing agents | Never self-approve |

Reviewer agents comment only; they never edit the PR.

#### 11.5.2 Capture (CI job `ui-visual`, attached as artefacts)

The routes and states affected by a PR are derived from `tests/visual/affected.ts`, a map from file to routes. When in doubt, the job runs the full matrix.

1. **Regression set:** `before.png`, `after.png` and `diff.png` at 1440×900, 1280×800 (wide-edge routes) and 390×844, light and dark, plus forced colors where listed.
2. **Conformance set** (page PRs from P3 on): a labelled `reference | actual` composite at 1440 and 390, light, from `tests/visual/stitch.ts`.
3. **Full page and fold crop:** hierarchy is judged on the 900px fold crop.
4. **Colour-independence views:** grayscale (an injected `filter: grayscale(1)`) and deuteranopia (CDP `Emulation.setEmulatedVisionDeficiency`) for every touched chart or status region.
5. **Stress views:** 320 reflow; 200% zoom at 1280 (a 640×400 viewport); text spacing; the long-content fixture.
6. **Computed-style audit** (`tests/visual/style-audit.ts`). It walks the DOM and reports every font-size, weight, line-height, colour, border colour, radius, padding, margin, gap and shadow value not produced by a token (resolved through the probe). It must be **0 on new pages**, and it ratchets on old ones. This is the main drift detector.
7. **Keyboard trace:** the ordered focus list with accessible names, plus the shortcut trace for Proposals.
8. **Component contact sheet** (R3, R4): every instance of each component across routes, cropped and tiled.

#### 11.5.3 How to compare (the reviewer's script; stop at the first blocking failure)

1. **Automated gates green?** (lint, axe, style audit, budgets). If not, return the PR without spending a visual review.
2. **Diff accounting.** Every coloured region in `diff.png` maps to a line in the PR's "Intended visual changes". An unmapped region is blocking.
3. **Conformance.** Compare reference and actual at the fold crop, then the full page:
   - section order;
   - primary-action placement;
   - alignment edges (`tests/visual/overlay.css` with `?overlay=1` draws a 4px grid and the content edge);
   - type roles (§7.0);
   - card nesting.
4. **States.** Loading → empty → low-data → error → partial → success, at 390 and 1440. Each has its own text and action, and none shifts the layout (compare skeleton and loaded block sizes).
5. **Dark and forced colors.** Light and dark side by side: the same element is most prominent in both. In forced colors every selected or pressed state is identifiable.
6. **Colour meaning.** In the grayscale and CVD views, every chart and status still reads, through labels, shapes and position.
7. **Score** with the anchored rubric (§11.3), with evidence per score.

#### 11.5.4 Writing feedback

Each comment is exactly one kind:
- **Blocking:** "violates §x / token / reference", with a crop or coordinates, the expected spec and the observed value.
- **Should:** within spec. The implementer may defer it with a reason.
- **Note:** not actionable in this PR. It goes on the PR's follow-up list.

Cite spec lines, not taste ("`h2` is `--text-xl`; §7.0 says `--text-lg`"). A taste comment must propose a token-level change, or it is a Note.

#### 11.5.5 Iteration rules (capture → review → fix → re-capture)

1. The implementer fixes every Blocking item and re-runs CI. The new artefacts **replace** the old in the same thread, labelled "Round N".
2. **At most 3 review rounds per PR** (D-50). If Blocking items remain after round 3, the PR is split, or the conflict escalates (§11.1). There is no fourth round.
3. In round 2 and later, a reviewer may not add new Blocking items about regions unchanged since round 1, unless they are regressions.
4. An approval includes the rubric table and the round number. A merge needs every required reviewer's approval **on the latest artefacts**; the approval comment quotes the artefact hash, and a CI check compares it.
5. After a merge that intentionally changed the target, the reference screens are updated in the same PR (VD re-approves). The reference never lags main by more than one PR.

#### 11.5.6 Reviewer prompts

These are in `docs/design/ui-overhaul/reviewer-prompts.md` (P0-0):

> You are the {VD|AX|DV} reviewer for akm ui. The spec is `docs/design/ui-overhaul/plan.md` §0, §4, §5, §7, §8.8 and §11. Compare the actual screens against **the reference screens and the spec**, not your taste. Do not edit the PR. Follow §11.5.3 in order.
>
> Output:
> 1. the automated gate status;
> 2. a diff-accounting table;
> 3. Blocking / Should / Note comments, each citing a spec line and a screenshot file;
> 4. the anchored rubric table with evidence (§11.3), for your dimensions only;
> 5. the verdict (approve / changes requested), the round number and the artefact hash.
>
> At most 3 rounds (§11.5.5).

---
## 12. Phased roadmap

**Lanes.** At most one agent per lane at a time, plus one extra S agent from Phase 2 on.

| Lane | Owns |
|---|---|
| **T** | Test infra: `tests/visual/**`, test helpers, CI workflow |
| **C** | CSS: every `*.css` file, tokens |
| **F** | Client JS: pages, `app.js`, `lib.js`, `components.js`, `icons.js`, `shortcuts.js`, `charts.js` |
| **V** | Charts: `chart-view.js`, `echarts.js`, `scripts/ui-echarts.ts` |
| **S** | Server: `src/commands/ui/*.ts`, `src/commands/metrics/*`, repositories, telemetry |

**Merge order**
- Within a lane, merge in ID order.
- Rebase onto `main` and re-run `ui-visual` before merge.
- A PR that has been red for more than 2 days is closed and re-cut.
- PR size is ≤ ~400 changed lines excluding baselines and fixtures. Mechanical PRs (P2-1b, P2-3, P2-4) may exceed it if the PR names the procedure and the gate is 0 diff, or the expected diffs are listed per region.

**akm-eval:** no child task belongs in `akm-eval`. The premise excludes eval results.

### 12.1 Shared files: one writer at a time

| Hot file | Rule |
|---|---|
| `styles.css` → all CSS | **Lane C owns it.** In Phase 1 a non-C task may add at most 20 CSS lines, rebases onto lane C's head and merges in queue order. **CSS freeze from P2-1a to P2-4:** no other PR touches CSS. After P2-4, a component's block belongs to the task that builds it, inserted alphabetically |
| `lib.js` | Sequence P1-2 → P1-6 → P2-5a → P2-9b. Afterwards it changes only for escaping, API, `fmt`, `prefs` and the `*Href` builders |
| `components.js` | Exports in alphabetical order; a new builder is inserted in place |
| `chart-view.js` | Lane V only. Sequence P1-4b (minInterval) → P2-2 (probe only) → P2-6a → P2-6b → P2-6c → P5-1a…e |
| `overview.js` / `overview-charts.js` | Sequence P1-4b → P1-5 → P2-6a → P3-2 → P5-2 → P5-3 |
| `proposals.js` / `proposal-actions.js` | Sequence P1-6 → P1-10 → P3-4 → P3-6 |
| `api.ts` | New routes live in their own modules (`pulse.ts`, `impact.ts`, `misses.ts`, `asset-improve.ts`); `api.ts` gets one import and one `ROUTES` line, alphabetical |
| `embedded-ui.ts` | Generated (P0-4). On a conflict, regenerate; never merge by hand |
| `docs/reference/ui-api.md` | One `##` section per route, alphabetical |
| `ui-client.test.ts` | Per-page `describe` blocks. A PR edits only its page's block, plus the `Ctx` type once (P2-9b) and the scan block (P0-3) |
| Visual baselines | A PR commits only the PNGs of its intended diffs. Two open PRs with baseline changes to the same route may not both be in review |

### 12.2 Phase 0: Baselines and safety nets

| ID | Task | Deps | Lane | Owned files (abridged) | Gate | Q |
|---|---|---|---|---|---|---|
| P0-0 | Commit the overhaul plan and templates to docs/design/ui-overhaul/ | — | T | docs/design/ui-overhaul/plan.md (verbatim copy of the approved plan), docs/design/ui-overhaul/task-brief-te… | none | — |
| P0-1a | Visual harness core: deterministic server, seed, 3 routes, CI job | P0-0 | T | tests/visual/playwright.config.ts, tests/visual/serve.ts, tests/visual/seed.ts, tests/visual/routes.pw.ts, … | R0 | Q-05, Q-06, Q-07 |
| P0-1b | Full current-route matrix, gallery harness and review tooling | P0-1a | T | tests/visual/** (matrix specs, affected.ts, stitch.ts, overlay.css, style-audit.ts, contact-sheet.ts, galle… | R0 | — |
| P0-1c | Make the ui-visual check required | P0-1b | T | none (branch protection); a short note in docs/design/ui-overhaul/plan.md is not needed | none | Q-08 |
| P0-2 | Accessibility ratchet and token contrast test | P0-1b | T | tests/visual/a11y.pw.ts, tests/visual/a11y-known.json, tests/ui-tokens-contrast.test.ts, package.json (devD… | none | — |
| P0-3 | CSS lint script, Biome CSS rules and source-scan ratchet | P0-1a | T | scripts/lint-ui-css.ts, tests/lint-ui-css.test.ts, scripts/lint-ui-css.allow.json, biome.json (override for… | none | — |
| P0-4 | Generate EMBEDDED_UI from the assets directory | P0-0 | S | scripts/gen-embedded-ui.ts, ui/embedded-ui.ts (generated), ui/server.ts (import swap only), package.json (`… | none | — |
| P0-5 | Asset size budget test | P0-0 | T | tests/ui-asset-budget.test.ts | none | — |

### 12.3 Phase 1: Bug fixes on today's architecture

| ID | Task | Deps | Lane | Owned files (abridged) | Gate | Q |
|---|---|---|---|---|---|---|
| P1-1 | Fix misleading state: command asset body and Bundles working stash | P0-1a | F | asset.js, bundles.js; ui/api.ts (bundles handler, only if the stash is missing from /api/bundles); tests | R2 | Q-19 |
| P1-2 | Router accessibility: live region, focus, skip link, titles, menu | P0-2 | F | index.html, app.js, lib.js (loading state only), search.js (status message only) | R2 | — |
| P1-3 | CSS defects: .check collision, control borders, targets, duplicates | P0-1b | C | styles.css, bundles.js (class rename), diff-view.js (NARROW only) | R2 | — |
| P1-4a | Overview numbers, server side: pending count, filters, ranking | P0-1a | S | ui/api.ts (overview handler), src/commands/metrics/collect.ts, src/commands/metrics/metrics-cli.ts, src/sto… | none (0 pixel diff); DV if a metric changes | — |
| P1-4b | Overview numbers, client side: labels, removals, interim fixes | P1-4a | F | overview.js, overview-charts.js, chart-view.js (minInterval only) | R2 | — |
| P1-5 | Zero-filled bins inside data coverage, partial bins, retrieval rate | P1-4b | S | src/commands/metrics/stats.ts (new: isoWeekStart, zeroFill, wilson, nearestRank), ui/metrics.ts, src/comman… | R2 | — |
| P1-6 | Proposal interaction fixes: focus while busy, Esc, errors, badges, no-op | P1-2 | F | proposals.js, proposal-actions.js, lib.js (fmt.relative/absolute only) | R2 | — |
| P1-7 | Diff accessibility: spoken signs, word marks, unchanged-lines button | P1-3 | F | diff-view.js; styles.css ≤ 20 lines (mark underline, gap-btn size) | R2 | — |
| P1-8 | Small fixes: editor, search, asset, history, config | P1-1, P1-2 | F | editor.js, search.js, asset.js, markdown.js, changes.js, config.js; ui/git-read.ts | R2 | — |
| P1-9 | Forced colors and non-colour selected states | P1-3, P1-7 | C | styles.css, charts.js (SVG swatches) | R2 | — |
| P1-10 | Proposals queue table with age bars (replace the backlog chart) | P1-6 | F | proposals.js, charts.js (ageBar); styles.css ≤ 20 lines | R2 | — |

### 12.4 Phase 2: Foundation (layers, tokens, components, chart wiring, server hygiene)

| ID | Task | Deps | Lane | Owned files (abridged) | Gate | Q |
|---|---|---|---|---|---|---|
| P2-1a | Cascade layers in place in styles.css (0 pixel diff) | P1-2, P1-3, P1-6, P1-7, P1-8, P1-9, P1-10 | C | styles.css | R2 (0-diff) | — |
| P2-1b | Split the stylesheet into one file per layer (0 pixel diff) | P2-1a, P0-4 | C | {layers,tokens,base,layout,components,pages,utilities}.css (new), index.html, delete styles.css, ui/embedde… | R2 (0-diff) | — |
| P2-2 | light-dark() tokens and the resolveColor probe (0 pixel diff) | P2-1b | C | tokens.css, other CSS (var substitution of equal-value tokens), chart-view.js (resolveColor only), app.js (… | R2 (0-diff) | Q-04 |
| P2-3 | Snap spacing, type and radius to the scale; contrast tokens | P2-2 | C | all CSS files | R2 | — |
| P2-4 | Modern layout: logical properties, nesting, containers, shell, width | P2-3 | C | layout.css, components.css (and other CSS for logical properties) | R2 | — |
| P2-5a | Extract existing builders into components.js (0 pixel diff) | P1-6, P1-8 | F | components.js (new), lib.js (re-exports, fmt helpers, prefs), ui/embedded-ui.ts (regenerate) | R2 (0-diff) | — |
| P2-5b | State attributes: data-tone badges, SVG swatches, ARIA state | P2-5a, P2-4 | F | components.js, components.css, pages (attribute changes only) | R2 | — |
| P2-5c | Core controls: button, field, tabs, chip, checkbox, disclosure, link, icons | P2-5b | F | components.js, icons.js (new), components.css, pages (swap markup for builders), embedded-ui.ts, tests/visu… | R1 → R2a → R2 | — |
| P2-6a | wireChart v2: addressing, scoped redraw, decals, failure state | P2-2, P1-5, P1-10 | V | chart-view.js, overview-charts.js (call sites), tests/ui-charts-ssr.test.ts | R2 | — |
| P2-6b | ECharts Tooltip in richText mode with richSafe | P2-6a | V | scripts/ui-echarts.ts, echarts.js (rebuilt), chart-view.js | R2 | — |
| P2-6c | Lazy chart initialisation on intersection | P2-6a | V | chart-view.js | R2 (0-diff) | — |
| P2-7 | Palette update: indigo accent, series fixes, validated ramp | P2-4, P2-6a | C | tokens.css, tests/ui-tokens-contrast.test.ts (ΔE assertion) | R2 | Q-03 |
| P2-8 | Theme control (System / Light / Dark) and segmented component | P2-2, P2-6a, P2-5c | F | components.js (segmented), components.css, app.js, index.html | R1 → R2a → R2 | — |
| P2-9a | Server hygiene: header-only token, projection, ETag, caps, Server-Timing | P1-1, P1-4a | S | ui/server.ts, ui/api.ts, src/storage/repositories/proposals-repository.ts, tests | none (0 pixel diff) | — |
| P2-9b | ctx.signal and ctx.api: abort requests on navigation | P1-6, P2-5a | F | app.js, lib.js, pages (api → ctx.api), tests/integration/ui/ui-client.test.ts (Ctx type) | R2 (0-diff) | — |
| P2-10 | derive.ts: classifyOutcome, p-chart, cohorts, and the parity test | P1-5 | S | ui/derive.ts, src/commands/metrics/stats.ts (binomialQuantile), tests/ui-derive.test.ts, tests/ui-metrics-p… | none (0 pixel diff); DV if a metric changes | Q-18 |
| P2-11 | Reference screens for Overview, Proposals, Improve and Asset | P2-5c, P2-7 | F | tests/visual/reference/*.html, tests/visual/reference/fixture.js, tests/visual/reference.pw.ts, tests/visua… | R1 → owner approval | Q-09 |

### 12.5 Phase 3: Navigation and workflows

| ID | Task | Deps | Lane | Owned files (abridged) | Gate | Q |
|---|---|---|---|---|---|---|
| P3-1 | Navigation regroup, routes, redirects and History rename | P2-4, P2-5c, P2-9a, P0-4 | F | index.html, app.js, changes.js → history.js, asset.js and editor.js (path params), components.js (breadcrum… | R1 → R2a → R2 | — |
| P3-2 | Overview restructure on existing data (30d, attention, strip, cards grid) | P3-1, P2-6a, P2-11 | F | overview.js, overview-charts.js, components.js, components.css | R1 → R2a → R2 | — |
| P3-3 | Review write routes: revert, reopen, batch reject | P0-1a | S | ui/proposal-actions.ts, ui/api.ts (summary fields revertable/decider), docs/reference/ui-api.md, tests | none (0 pixel diff) | — |
| P3-4 | Proposals split view, why block, sticky action bar, diff summary | P3-1, P1-10, P2-11 | F | proposals.js, components.js (detailPanel, definitionList v2), components.css, layout.css (review split) | R1 → R2a → R2 | — |
| P3-5 | Shortcut layer, help dialog, kbd and status bar components | P2-5c | F | shortcuts.js (new), components.js, components.css, embedded-ui.ts | R1 → R2a → R2 | — |
| P3-6 | Decide, undo, revert, reopen and batch reject in the UI | P3-3, P3-4, P3-5 | F | proposals.js, proposal-actions.js | R2 → R3 Proposals | — |
| P3-7 | Search tabs, visible filters, match highlighting, create-from-query | P3-1 | F | search.js, editor.js (prefill from ?q=), lib.js (searchHref, newKnowledgeHref) | R1 → R2a → R2 | — |
| P3-8 | Asset page: rail, Edit or Suggest a fix, feedback buttons | P3-1, P2-11 | F | asset.js, components.css, ui/workspace-actions.ts (feedback replace[]/with[]), tests | R1 → R2a → R2 | — |
| P3-9 | Bundles, Config and History polish | P3-1 | F | bundles.js, config.js, history.js, components.js (pathText), components.css | R2 → R3 Bundles, Config and History | — |
| P3-10 | Editor workflow polish: tabs, guard, name hints, load error | P3-1 | F | editor.js, app.js (guard), index.html | R2 | — |

### 12.6 Phase 4: Data routes and telemetry (lane S, runs alongside Phases 2–3)

| ID | Task | Deps | Lane | Owned files (abridged) | Gate | Q |
|---|---|---|---|---|---|---|
| P4-1 | Weekly bins, 12-week rate series and 90d window in /api/overview | P2-10 | S | ui/metrics.ts, ui/api.ts, docs/reference/ui-api.md, tests | none (0 pixel diff); DV if a metric changes | — |
| P4-6 | /api/search/misses route | P2-10 | S | ui/misses.ts, api.ts (one line), docs, tests | none (0 pixel diff) | — |
| P4-2 | /api/overview/pulse: tiles, runs, attention, improve line, set-up | P4-1, P4-6 | S | ui/pulse.ts, api.ts (one line), docs, tests | none (0 pixel diff); DV if a metric changes | — |
| P4-3 | Proposal outcome projection and drill-down filters | P2-9a, P2-10 | S | storage/repositories/proposals-repository.ts (listProposalOutcomeRows), metrics-repository.ts (select metad… | none (0 pixel diff) | — |
| P4-4 | /api/improve/impact core sections | P4-3 | S | ui/impact.ts, api.ts (one line), docs, tests | none (0 pixel diff); DV if a metric changes | — |
| P4-5 | Impact join: changed assets before and after | P4-4 | S | ui/impact.ts, tests | none (0 pixel diff); DV if a metric changes | — |
| P4-7 | /api/asset/improve route | P4-3 | S | ui/asset-improve.ts, api.ts (one line), docs, tests | none (0 pixel diff) | — |
| P4-8a | G4: library size on index_completed | P0-0 | S | src/indexer/indexer.ts, tests | none (0 pixel diff) | — |
| P4-8b | G2: keep acceptedAt on proposals | P0-0 | S | src/commands/proposal/repository.ts (promoteProposal), src/storage/repositories/proposals-repository.ts (de… | none (0 pixel diff) | — |
| P4-8c | G3: review.decidedBy from accept/reject callers | P0-0 | S | src/commands/proposal/proposal.ts (decidedBy option), src/commands/proposal/drain.ts (passes 'triage'), val… | none (0 pixel diff) | Q-12 |
| P4-9 | G10: source and searchId on search and select events | P0-0 | S | src/commands/read/search.ts, src/indexer/usage/show-usage.ts, src/commands/metrics/*, tests | none (0 pixel diff) | — |

### 12.7 Phase 5: Dashboard pages

| ID | Task | Deps | Lane | Owned files (abridged) | Gate | Q |
|---|---|---|---|---|---|---|
| P5-1a | Chart builder: pChartLine | P2-6b, P2-10 | V | chart-view.js (builder inserted alphabetically), tests/ui-charts-ssr.test.ts, tests/visual/gallery.* | R1 → R2a → R2 | — |
| P5-1b | Chart builder: stackedColumns | P2-6b | V | chart-view.js (builder inserted alphabetically), tests/ui-charts-ssr.test.ts, tests/visual/gallery.* | R1 → R2a → R2 | — |
| P5-1c | Chart builder: divergingColumns | P2-6b | V | chart-view.js (builder inserted alphabetically), tests/ui-charts-ssr.test.ts, tests/visual/gallery.* | R1 → R2a → R2 | — |
| P5-1d | Chart builder: stepLine and lines | P2-6b | V | chart-view.js (builder inserted alphabetically), tests/ui-charts-ssr.test.ts, tests/visual/gallery.* | R1 → R2a → R2 | — |
| P5-1e | Chart builder: eventStrip | P2-6b | V | chart-view.js (builder inserted alphabetically), tests/ui-charts-ssr.test.ts, tests/visual/gallery.* | R1 → R2a → R2 | — |
| P5-2 | Pulse tiles and the improve line on Overview | P3-2, P4-2 | F | overview.js, components.js (tile, pulseTile), charts.js (sparkline), components.css | R1 → R2a → R2 | — |
| P5-3 | Overview trend cards and the 30d/90d control | P5-2, P4-1, P5-1a, P5-1b, P5-1d, P5-1e, P2-6c | F | overview-charts.js, overview.js, components.js (segmented reuse) | R2 → R3 Overview | — |
| P5-4 | Improve impact: page shell, outcomes, review flow, library change | P3-1, P4-4, P4-8c, P5-1b, P5-1c, P5-1d | F | improve.js (new), components.js (chartGrid, term), components.css, layout.css (toc), embedded-ui.ts, app.js… | R1 → R2a → R2 | Q-14, Q-15 |
| P5-5 | Improve impact: harm log, cost, judge and you | P5-4, P5-1e | F | improve.js | R2 | — |
| P5-6 | Improve impact: changed assets table | P5-5, P4-5 | F | improve.js | R2 → R3 Improve impact | — |
| P5-7 | Search Misses tab on the misses route | P3-7, P4-6 | F | search.js | R2 → R3 Search | — |
| P5-8 | Asset improve history in the rail | P3-8, P4-7, P5-1e | F | asset.js, charts.js (sparkline reuse) | R2 → R3 Asset | — |
| P5-9 | User guide, glossary, ratchets emptied, final review | P5-3, P5-6, P5-7, P5-8, P3-6, P3-9, P3-10 | F | docs/guides/ui.md (new), docs/reference/ui-api.md, components.js (term keys), ratchet files (emptied) | R4 | — |

### 12.8 Phase 6: later (not issues yet; file when the prerequisites land)

| ID | Item | Prerequisites |
|---|---|---|
| P6-1 | Adoption pairs (M-33), derived-memory exposure (M-13), extraction outcomes | P4-9; verify the extraction outcome vocabulary |
| P6-2 | Retirement follow-through (M-31), lost-query harm row, "What happened to searches for retired notes" | P5-6 (D-32) |
| P6-3 | Matched comparison (§5.4) | P4-9, P6-5a, DV sign-off |
| P6-4 | ⌘K palette (D-20) | P3-1 |
| P6-5a / P6-5b | G7 rollup (migration) / G6 retention | Q-01 / Q-02 |
| P6-6 | G5 runId; G9 config events on the strip | — |
| P6-7 | G8 expected schedules | Q-13 |
| P6-8 | Chart keyboard stepping model (D-28) | AX spec |
| P6-9 | Top-3 selection share (M-08) | P4-9 + ≥ 8 weeks of data |

### 12.9 Critical path

**P0-0 → P0-1a → P0-1b → P1-3 → (Phase 1 CSS tasks) → P2-1a → P2-1b → P2-2 → P2-3 → P2-4 → P2-5b → P2-5c → P2-7 → P2-11 → P3-2 → P5-2 → P5-3.**

- The S lane (P0-4, P1-4a, P2-9a, P2-10, P3-3, P4-*) runs in parallel, and should be done by the time P3-2 merges.
- The second chain is Improve: P4-3 → P4-4 → P4-5 and P5-1b/c/d → P5-4 → P5-5 → P5-6.

---

## 13. Risks, owner questions, out of scope

### 13.1 Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Flaky baselines erode trust in R2 | Medium / High | Pinned image by digest, fixed server and SQL time, masks, two-run determinism, flake budget (§8.7) |
| Baseline churn swamps review | High / High | Gallery-first review for system PRs; the reduced matrix; one route's baselines in review at a time; diffs grouped by component |
| Reviewer-agent bandwidth (about 70 PRs × 2–3 roles) | High / Medium | Prompts in the repo; 1-day SLA; DV only on chart or metric PRs; CD folded into VD; at most 3 rounds |
| Low personal volume leaves charts empty for weeks | High / Medium | Designed in: counts, "Building your usual range", R10 stats, positive empty states; R3 reviews low-data states |
| Readers take Linked tables as proof | Medium / High | No difference field (tested), subtitle copy, DV at R1/R3 |
| Persisted-field changes by UI-focused agents (G2, G3, G10) | Medium / High | Separate tasks P4-8a/b/c and P4-9 with core-owner review, validator tests, compat doc |
| UI and CLI disagree on a number | Medium / High | The parity test (D-54) |
| Hot-file conflicts across parallel agents | Medium / Medium | §12.1, generated embed map, per-route modules, alphabetical insertion |
| Agents "fix" adjacent code | Medium / Medium | "Must not touch" lists; reviewers reject unexplained hunks (S-23) |
| Browser support for `light-dark()`, `:has()`, `color-mix()` | Low / Medium | Floor + boot notice (D-53) |
| Playwright or image bumps reset baselines | Medium / Medium | Bump alone in a baseline-only PR |
| Undo after accept conflicts with later edits | Low / Medium | Undo only while the status bar shows; clear errors with next steps |
| Owner questions unanswered | Medium / Low | Every question has a default (§13.2); a task proceeds on the default unless the owner objects within 2 business days |

### 13.2 Owner questions (single list)

Each question has a recommended default, and work proceeds on the default. The "Blocks" column names the task that waits for an answer or for the default to stand.

| ID | Question | Recommended default | Blocks |
|---|---|---|---|
| Q-01 | Approve the G7 query-free daily rollup (the only state.db migration) for long baselines? | Yes, in P6-5a. | P6-5a |
| Q-02 | Allow configurable raw usage retention beyond 90 days (G6)? Queries are stored verbatim after redaction. | No; G7 covers long trends without queries. | P6-5b |
| Q-03 | Approve the palette change: indigo accent, light --s3, darker dark-mode series, validated age ramp (§7.1)? | Yes, as its own reviewed PR. | P2-7 |
| Q-04 | Accept the browser floor Chrome/Edge 123, Firefox 121, Safari 17.5 with a boot notice, and no non-light-dark() fallback? | Yes. | P2-2 |
| Q-05 | Which Playwright version and Docker image? | Current stable @playwright/test on the day P0-1a starts, exact-pinned; image mcr.microsoft.com/playwright:v<same>-noble pinned by digest; bumped only in baseline-only PRs. | P0-1a |
| Q-06 | Fixed date and seed for visual tests? | FIXED_NOW = 2026-06-17T14:20:00Z (a Wednesday), port 9391, token visual-token, seed per Appendix C. | P0-1a |
| Q-07 | May CI run a container job, and how long may ui-visual take? | Yes; ≤ 10 minutes per run. | P0-1a |
| Q-08 | Who makes ui-visual a required check, and when? | The owner, after 5 consecutive green runs on main. | P0-1c |
| Q-09 | Owner approval of the P2-11 reference screens. | Required; if no reply within 2 business days, VD approval stands provisionally and the owner may reopen later. | P2-11, then P3-2, P3-4, P3-8, P5-4 start |
| Q-10 | Who does the human screen-reader pass (NVDA+Firefox or VoiceOver+Safari) and the macOS/Windows spot check? | The owner, at R3 Proposals, R3 Improve, R3 Overview (spot check) and R4. | R3 sign-off of P3-6, P5-3, P5-6; P5-9 |
| Q-11 | Should the UI ever write config.json? | No; Config stays read-only (D-19). | none (P3-9 proceeds read-only) |
| Q-12 | Should a hand-run `akm proposal drain` count as the judge or as you? | As the judge until a 'human-drain' value is designed (D-43). | none (copy in P5-4) |
| Q-13 | Where is the authoritative expected schedule for improve and tasks (G8)? | No missed-run detection in v1. | P6-7 |
| Q-14 | Improve impact default scope: all bundles or the write target? | All bundles, with a filter. | P5-4 |
| Q-15 | When experimental.improveAutonomy is off, hide memory rows or show 'Off'? | Show 'Off' with the setting name. | P5-4 |
| Q-16 | Add a UI 'Patterns' (decals) toggle beyond the media queries? | No (D-04). | none |
| Q-17 | Offer revert of retirements (un-retire) in the UI? | Yes, with an inline confirm. | P3-6 |
| Q-18 | Make minimum samples configurable? | No; fixed constants in derive.ts (§6). | P2-10 |
| Q-19 | Show the working stash as a separate first card on Bundles? | Yes. | P1-1 |
| Q-20 | Branch protection and labels: may the P0-0 agent create labels and the ui-overhaul issue template? | Yes if the token permits; otherwise the owner creates them from the list in P0-0. | P0-0 |
| Q-21 | Reviewer agents: 1-business-day turnaround, CD folded into VD? | Yes. | all gated tasks |

#### 13.2.1 Owner answers (2026-11-01)

The owner answered these questions on 2026-11-01. Answers that differ from the recommended default are marked **changed**; they override the default above and any brief that assumed it.

| ID | Answer |
|---|---|
| Q-01 | Yes: the daily rollup (G7) in P6-5a. |
| Q-02 | No configurable raw retention; raw usage stays at 90 days. |
| Q-03 | Approved: palette change as its own reviewed PR (P2-7). |
| Q-04 | Approved: browser floor Chrome/Edge 123, Firefox 121, Safari 17.5, notice on older browsers, no fallback. |
| Q-05 | Default: latest stable `@playwright/test`, exact-pinned; `mcr.microsoft.com/playwright` image pinned by digest. |
| Q-06 | Default: FIXED_NOW 2026-06-17T14:20:00Z, port 9391, token `visual-token`, seed per Appendix C. |
| Q-07 | Yes: `ui-visual` container job, at most 10 minutes per run. |
| Q-08 | The owner makes `ui-visual` required after 5 consecutive green runs on main. |
| Q-09 | **Changed.** Design reviewer agents approve the P2-11 reference screens; the owner is not in the loop and page work does not wait for the owner. |
| Q-10 | **Changed.** No human screen-reader pass or macOS/Windows spot check for now. R3 and R4 rely on automated accessibility-tree snapshots and axe; the human passes are deferred to Phase 6. |
| Q-11–Q-20 | Recommended defaults stand. |
| Q-12 | As the judge (default confirmed). |
| Q-14 | All bundles, with a filter (default confirmed). |
| Q-17 | Yes: un-retire in the UI with an inline confirm (default confirmed). |
| Q-21 | **Changed.** Keep a separate content-design (CD) reviewer: four reviewer roles (VD, AX, DV, CD); copy and microcopy get their own sign-off. Turnaround stays 1 business day. |

### 13.3 Out of scope

- Version, release or build comparisons; eval or ledger import.
- Scores, ROI, money, "tokens saved".
- Causal estimates in v1.
- Before/after on utility or outcome scores; `improve_ledger` over time.
- Auto-refresh. Writes from charts. Config writes.
- A density toggle. A framework.
- Multi-user features.
- Restoring the canary metrics removed in migration 028.
- Every P6 item until its prerequisites land.

---

## Appendix A. Task brief template (one per child issue)

The template is also committed as `docs/design/ui-overhaul/task-brief-template.md`.

```markdown
# <ID> <imperative title>
Labels: ui-overhaul, phase:<n>, lane:<T|C|F|V|S>, gate:<…>, <topic>   ·   Lane: <X>   ·   Depends on: <IDs>   ·   Owner questions: <Q-ids → default>

## Goal
One sentence: what is true for the user or the codebase when this merges.

## Context
Plan: docs/design/ui-overhaul/plan.md §…; decisions D-…; bugs B-…; visuals V-…; metrics M-….
Verified code facts the implementer relies on (file:line).

## Files
- Owned (may edit): …
- May touch minimally: … (CSS ≤ 20 lines outside lane C; say why)
- Must NOT touch: CSS during the freeze (P2-1a…P2-4) unless lane C; other pages; ci.yml; baselines of unrelated routes.
- Generated: run `bun scripts/gen-embedded-ui.ts` when a UI file is added, removed or renamed.

## Steps (each with its check)
1. Write the failing test that reproduces the bug or requirement → verify it fails for the right reason.
2. … → verify: …

## Standards (plan §8.8)
Owner requirement: modern CSS and clean code (plan §8 intro). Items: S-… (with names). S-23 always applies.

## Tests
Unit/integration: … · Visual: routes/states expected to change; everything else 0 diff · a11y ratchet entries expected to close · budget delta.

## Local gates before "ready for review"
`bun run lint:fix` · `bunx tsc --noEmit` · `bun test <focused files>` · `bun run check:changed` · `bun run test:ui-visual:docker` (UI PRs)

## Design review gate
R1 → R2a → R2 (→ R3). Capture → review (plan §11.5.3) → fix → re-capture, at most 3 rounds, then split or escalate. Who signs.

## Acceptance criteria
- [ ] observable, testable statements (test names)
- [ ] `bun run check` and `ui-visual` green; diffs only where listed
- [ ] docs updated (ui-api.md for API changes; compat doc for persisted fields)

## Out of scope
…
```

## Appendix B. Reviewer prompts

See §11.5.6. P0-0 copies them to `docs/design/ui-overhaul/reviewer-prompts.md` with the §11.3 rubric.

## Appendix C. Visual seed dataset (also `docs/design/ui-overhaul/seed-spec.md`)

**Constants:** `FIXED_NOW = 2026-06-17T14:20:00Z`, port 9391, token `visual-token`. Every timestamp is written explicitly, relative to `FIXED_NOW`.

**Seeded data**
- **Searches:** 13 weeks of user searches, about 40 a week:
  - 6% found nothing;
  - 3 repeat misses on ≥ 2 days;
  - one burst of 8 identical failing queries within 10 minutes (tests the repeat merge);
  - `totalMs` on 90%.
- **Curates:** daily curate rows (hook-like).
- **Feedback:** signed, with 2 negatives in the last 7 days (including `stash//lessons/rg`, reason "outdated flag").
- **Proposals** across reflect, distill, consolidate, consolidate-pair, extract and feedback, in every status:
  - pending in each age band, plus one unknown age;
  - judge-accepted (`auto-accepted`/`triage`);
  - you-accepted;
  - staged-then-accepted;
  - judge-rejected;
  - you-rejected;
  - procedural (expired);
  - reverted;
  - one no-op;
  - one create;
  - one retire with continuity risk;
  - one reopened.
- **Improve runs:** 14, with 1 failed and 1 dry run.
- **Tasks:** 2, with 1 failed and 1 `active` started 8 h ago.
- **llm_usage:** per process, with one week at 40% token coverage.
- **Assets:** a command asset (template body) and a knowledge asset with feedback and proposals.
- **Git:** a stash with 6 dated commits, one with a subject naming an accepted ref.
- **Index:** one full reindex event and one retirement batch (3 in a day).

**Variants**
- **Empty:** a fresh sandbox.
- **Low data:** 1 active day, 6 searches.
- **Data starts mid-window:** the oldest `usage_events` row is 20 days ago.
- **Long content:** an 80-char ref, a 120-char query, a 6-digit count, a 40-segment path.

## Appendix D. Copy

**How to read this page** (Improve impact; a short version sits in Overview's Measurement coverage)

> **What the labels mean**
> - **Recorded:** counted straight from akm's own records, such as proposals, runs and searches.
> - **Classified:** sorted by a rule we can explain. For example, "accepted by the judge" means akm's review rules accepted it with no per-proposal decision by a person.
> - **Linked:** something that happened to the same asset afterwards. It does not show that the change caused it.
> - **Correlated:** placed on the same timeline so you can see what happened around then. Nearness in time is not a cause.
>
> **Kept** means accepted at least 14 days ago and not reverted. Newer accepts have not had time to be reverted, so they are shown separately.
>
> Times are UTC. Weeks start Monday 00:00 UTC.

**Glossary entries** (shown through `term()`)
- **Your usual range:** "The shaded band with dashed edges. It shows how much this rate moves by chance at this volume, based on the 8 weeks before the latest one. A point outside it is unusual for you. That is worth a look, but not proof that something broke. Quieter weeks have a wider range."
- **The bracket after a rate:** "As in 6.1% (4.0–9.2%, n=212). This is how precisely the period's own numbers pin down the rate. With fewer searches the bracket is wider. It answers 'how sure are we of this number', not 'is this unusual'."
- **Too few to show a rate:** "Below 30 searches (or 10 rated feedback) in a period, the point is an open circle with no line, and the table shows the counts."
- **Judge:** "akm's automatic review (the triage drain). It accepts or rejects some proposals by rule."
- **Continuity risk:** "Before retiring a note, akm replays up to five of its past queries; the successor must also rank in the top 10."
- **Token coverage:** "The share of model calls that reported token counts. Unknown is not zero."

**State copy**

| State | Copy |
|---|---|
| Building baseline | "Building your usual range: 2 of 4 weeks so far. Until then, counts only." |
| Below minimum | "Not enough searches this week to show a rate (12; a rate needs 30)." |
| In progress | Bar label "so far"; table "(in progress, to 14:20 UTC)" |
| Data starts | Rule label "data starts 3 Aug"; caption "akm keeps search records for 90 days." |
| Partial coverage | "partial: tokens for 40 of 95 calls" |
| Chart failed | "Chart unavailable. The same numbers are in Data and details below." |
