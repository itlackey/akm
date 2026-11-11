# Visualization prototypes

Four standalone pages that show what Desktop's visualizations could be, and the analysis behind them.
Each page is one self-contained HTML file with no dependencies: open it in a browser. The data in them
is synthetic, shaped like akm's real tables; they read nothing from akm and are not part of the app.

All four views have since been built in Desktop, from the akm operations the analysis below asks for;
[visualizations](../visualizations.md) describes them as shipped and lists their limits. The run
timeline in the app has no zoom, and its marks have no width. The analysis is kept as written.

## Recommendation

Build four views, in this order. Each has a working HTML example in this folder.

| # | View | The question it answers | Example |
|---|---|---|---|
| 1 | **Library map** | What is in my library, how is it connected, and which parts are actually used? | `01-library-map.html` |
| 2 | **Run timeline** | What ran, when, and what failed? (tasks, workflow runs, improve runs, index builds on one clock) | `04-run-timeline.html` |
| 3 | **Workflow run trace** | What is this run doing right now, and where did it lose time or fail? | `03-workflow-run.html` |
| 4 | **Activity replay** | What did agents look for and read today, and where did search come up empty? | `02-activity-replay.html` |

The order is by how much akm already stores. Views 1 to 3 need only new read operations over existing data. View 4 works today but is much better after one small core change (below).

Render the map with a small hand-written WebGL2 renderer checked into Desktop, not a graph library. Render everything else as ordinary SVG or canvas components.

## What akm stores today, and the gaps

**Knowledge graph. The data exists; no operation returns it.**
- Nodes are the rows of `entries` in index.db (`src/storage/repositories/index-entry-schema.ts:35`). There are 15 built-in asset types.
- Edges are `asset_links` (same file, line 61): eight declared kinds read from frontmatter with no model involved: `xref`, `superseded_by`, `contradicted_by`, `belief_peer`, `derived_from`, `cites`, `links_to`, `uses` (`src/indexer/links/declared-links.ts`).
- Per-asset use is in `utility_scores` (`show_count`, `search_count`, `last_used_at`), with more in state.db `asset_outcome` and `asset_salience`.
- One embedding per asset is in `embeddings` (384 dimensions with the default local model).
- Gap: `assets.search` is capped at 200 results (`src/workspace/readers.ts:50`), links are readable one asset at a time, and vectors cannot be read out by ref. Nothing returns all nodes and all edges.
- The old LLM entity graph tables are dropped; do not build on them.

**Agent activity. Events exist; they do not say which agent.**
- `events` and `usage_events` in state.db record every search (query, hit count, result refs), show, select, feedback and write, with timestamps.
- Gap: these rows carry only `source` (`user`, `improve`, `task`, `audit`, `unknown`). Harness and session id are recorded on workflow runs but not on search, show or feedback. `resolveAgentIdentity()` already exists (`src/workflows/runtime/agent-identity.ts:55`); stamping its result on those events is the change that makes "activity per agent" possible.

**Workflows. Rich run data, shown nowhere.**
- A workflow is a sequence of steps, not a general dependency graph. Parallelism is map fan-out inside a step; a gate is a judge's check that can loop; a unit can start a child run.
- `workflow_run_units` and `workflow_run_unit_attempts` record start, finish, status, tokens, runner, model and failure reason per unit and per attempt. Steps have no start time, so a step's span must be derived from its units.
- `getWorkflowStatus(runId, { includeUnits })` and `listWorkflowRuns()` exist in `src/workflows/runtime/runs.ts`, but the workspace API and Desktop expose neither.

**Tasks and improve.**
- `task_history` and `improve_runs` hold start, end and status. What triggered a task run (schedule, CLI, workflow) is not stored.
- Desktop already charts weekly retrieval, feedback, improve outcomes, cost, and a per-task run table (`ActivityOverview.svelte`, `ActivityImpact.svelte`). The run timeline replaces none of that; it adds the one view those lack: all run kinds against the same clock.

## The four views

**1. Library map** (`/library/map`). Every asset is a dot.
- Size is how often it is shown. Colour is type, bundle or use. Lines are declared links, switchable by kind.
- Two arrangements: by meaning (from embeddings) and by bundle (always available, needs no embeddings).
- Search, hide a group, highlight never-shown or superseded/contradicted assets, click an asset to see its links and open it in Library.
- The 15 types fold into 8 colour families, because 8 is the most a categorical palette can separate. The palette passes the colour-blindness checks against akm's light and dark backgrounds; four of the light-theme colours fall below 3:1 contrast, so the legend and a table view are required, not optional.

**2. Run timeline** (Activity, Runs: `/activity/overview?view=runs`). One row per task, workflow, improve and index.
- Completed runs are quiet grey; failures are taller, red and carry a cross, so they are the first thing seen.
- A gap in a regular row shows the machine was not running. The example draws no "missed run" marker: that would be a new derived metric, which Desktop's rules exclude.
- Zoom from 14 days to an hour. Clicking a workflow run opens its trace.

**3. Workflow run trace** (opened from a workflow run on the timeline).
- Top: the steps in order, each saying what it reads from earlier steps.
- Below: every unit and attempt on one clock. Fan-out, retries, gate loops and child runs are all visible. Click a unit for runner, model, tokens, attempts and its failure text.

**4. Activity replay** (`/activity/replay`).
- A day of events plays over the map: assets light up as they are read, feedback pulses green or red.
- A timeline below shows volume by source and the searches that found nothing; drag it to move through the day.

**Not prototyped, since built:** a small neighbourhood diagram inside the asset inspector, drawn from what `assets.show` and `assets.related` already return. It is the link map on an asset's Related tab.

**Considered and dropped:** a flow diagram of the improvement loop. `ActivityImpact.svelte` already shows those counts by week.

## Integration into the Svelte project

**Rendering**
- Add `src/lib/ui/graph-gl.js` (about 400 lines; it is the renderer inside examples 1 and 2) and a `GraphView.svelte` that owns its lifetime, the same split as `chart-view.js` and `ActivityChart.svelte`.
- Why not a library: Desktop has three runtime dependencies and vendors a cut-down ECharts rather than depend on it (`THIRD_PARTY.md`). The vendored ECharts subset is SVG bar, line and scatter and cannot draw 30,000 nodes. The renderer needs nothing the CSP forbids (`script-src 'self'`, `vite.config.ts`).
- When a library would be worth it: if you want layout computed live in the browser on the GPU (cosmos.gl), or true 3D scenes (three.js). Neither is needed if akm supplies positions.
- The trace and the timeline are small. Build them as plain Svelte components with SVG or a 2D canvas.

**Data: new read operations in akm core, not in Desktop** (`desktop/AGENTS.md`: akm owns anything an agent or script would want and anything that reads akm's data)
- `assets.graph()`: all nodes, links, use counts and positions in column form (one array per field, bundle and type as small integers). At 30,000 assets this is a few megabytes of JSON.
- `activity.workflowRuns()` and `activity.workflowRun({ id })`: thin wrappers over the two existing functions.
- `activity.runs({ since })`: task, workflow, improve and index runs in one list.
- `activity.events({ since, until })`: the event stream for the replay.
- Each is one line in `src/lib/server/routes.ts`. `success()` in `http.ts` walks every string in a response to scrub credentials; measure that on the graph payload.

**Positions**
- Compute them in akm, once per index build, and cache them. The browser should not lay out 30,000 nodes on each visit.
- "By bundle" is deterministic and cheap. "By meaning" needs a projection of the stored embeddings to two or three dimensions; `bundles.list().index.embeddingCoverage` says whether to offer it.
- Which projection to use is the main open engineering question. None was built or benchmarked.

**Routes**: add `map` to `libraryView` and `replay` to `activityView` in `src/params.ts`. Runs is already a view of `/activity/overview`.

**Desktop's rules the examples already follow**: colours come from the design tokens and follow the theme; each view has a text panel beside it; reduced motion stops rotation and animation; the map can be turned, panned and zoomed from the keyboard; no invented scores. Still to add for the map: a full Table view, as `ActivityChart.svelte` has.

**Tests**: put filtering, colouring and selection in plain `*-model.ts` files tested with `node:test`, like the existing models. The Playwright suites can drive WebGL in headless Chromium (that is how these examples were checked).

## What was verified, and what was not

- Verified in headless Chromium: all four examples load with no errors in dark and light themes and at phone width; the map loads 30,000 and 100,000 nodes; hover, click and drag picking hit the right asset; search, filters, layout switch, replay and zoom work.
- Frame time was 20 to 25 ms at both 30,000 and 100,000 nodes, but that is software rendering with no GPU. Performance on a real GPU and inside Electron is not measured.
- All data is synthetic. The real link density, type mix and embedding structure will change how the map looks.
