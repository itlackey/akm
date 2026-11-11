# Visualizations

Desktop draws two pictures of what AKM already reports, and lists here the pictures it cannot draw
yet and the AKM operation each one is waiting for. Both pictures use only `akm-cli/workspace`
operations that existed before them, the vendored chart renderer, and plain SVG. Neither adds a
metric: every mark is a recorded run or a recorded link.

## Run timeline (Activity, Runs)

One row per scheduled task, then Improve and Index builds, on one clock: the metrics window chosen
on the page. A mark is where a run started. A circle finished, a triangle failed, a diamond ended
another way (blocked, still active, or no outcome recorded). A gap is a time with no recorded run;
nothing says whether a run was expected then. Selecting a task's mark opens that task's recorded
runs below. Table gives each row's counts and latest run.

It reads `activity.overview` (the task list, the improve runs, the index builds) and
`activity.taskHistory` once per listed task.

Limits, all from what those operations return:

| Limit | Why |
| --- | --- |
| A task row holds its latest 200 runs | `activity.taskHistory` returns at most 200 rows per call and has no offset. The table says when more were recorded. |
| Only the 20 tasks with the most runs have a row | `activity.overview` lists the top 20 tasks of the window. |
| Improve shows its latest 10 runs, Index its latest 20 builds | `activity.overview` returns `improveRuns` (latest 10, all time) and `metrics.index.recent`. |
| No workflow runs | The overview carries only totals (`metrics.workflows`). No workspace operation lists runs. |
| A mark has no width | The vendored chart (bar, line, scatter) has no interval mark. A run's duration is in its tooltip. |
| Not whether a schedule fired, a CLI call or a workflow started a task | `task_history` does not store the caller. |

## Link map (Library, an asset's Related tab)

The asset in the middle, what links to it on the left and what it links to on the right, grouped by
kind of link, with an arrow pointing at the target. A target AKM could not find is named, dashed,
and is not a link. "Add similar content" adds the nearest stored embeddings, dashed, because
similarity is not a recorded link. Each asset shown is a link to its own page.

It reads the `links` of `assets.show`, which the page already has, and `assets.related` when asked.

Limits:

| Limit | Why |
| --- | --- |
| One step only | Links are read one asset at a time. A second step would be one `assets.show` per neighbour, and that operation also reads the body, feedback and history. |
| At most 10 assets per kind and direction | `assets.show` returns ten refs per group and a total; the map says how many it was not given. |
| At most 20 similar assets | `assets.related` returns the 20 nearest. |

## Not built: what each needs from AKM

These were prototyped as standalone pages against synthetic data
([prototypes](prototypes/README.md)). None can be built from today's workspace API without Desktop
reading AKM's databases itself, which it must not do (`AGENTS.md`). Each needs a read operation added to `akm-cli/workspace`; the data and, where named,
the internal function already exist.

| View | What it shows | Needs from AKM |
| --- | --- | --- |
| Library map | Every asset as a point, its links as lines, coloured by type or bundle and sized by use | `assets.graph()`: every indexed entry (ref, type, bundle, title), every declared link (`asset_links`, resolved to entries), and per-asset use (`utility_scores`), in column form. Today `assets.search` stops at 200 results, `readEntryLinks` reads one asset, and nothing returns use for all assets. |
| Library map, arranged by meaning | The same points placed so similar assets sit together | Positions computed in AKM from the stored embeddings, once per index build. Desktop cannot read vectors (`assets.related` returns scores, not vectors), and laying out tens of thousands of points in the page on every visit is too slow. Which projection to use is undecided. Arranging by bundle and type needs only `assets.graph()`. |
| Workflow run trace | One run's steps in order, and every unit and attempt on one clock | `activity.workflowRuns()` and `activity.workflowRun({ id })`, over `listWorkflowRuns` and `getWorkflowStatus(runId, { includeUnits: true })` in `src/workflows/runtime/runs.ts`. A step has no start time of its own; the trace derives it from the step's units. |
| Workflow rows on the run timeline | Workflow runs beside tasks, improve and index | The same `activity.workflowRuns()`, with each run's `created_at`, `completed_at` and status. |
| Activity replay | Searches, shows, feedback and writes of a period, in order | `activity.events({ since, until })`: the usage rows of the window. `akm metrics --detail full` already builds them (`readUsageRows`); `activity.overview` leaves them out. |
| Activity by agent | The same events grouped by harness and session | Search, show and feedback events to record who made them. They carry only `source` (`user`, `improve`, `task`, `audit`). `resolveAgentIdentity()` (`src/workflows/runtime/agent-identity.ts`) already resolves the harness and session and is recorded on workflow runs only. |
| Longer task rows, every task | More than 200 runs per task, more than 20 tasks | An offset or cursor on `activity.taskHistory`, or one operation that returns the window's runs for all tasks. |
| What started a task run | Schedule, CLI or workflow, on the timeline | The caller stored in `task_history`. |

The library map at tens of thousands of assets also needs a WebGL renderer in Desktop (the vendored
chart draws SVG, which does not hold that many marks). That is Desktop's to add, and is only worth
adding once `assets.graph()` exists.
