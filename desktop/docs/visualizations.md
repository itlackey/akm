# Visualizations

Desktop draws five pictures of what AKM records. None adds a metric: every mark is a recorded run, a
recorded event, a recorded link or an indexed asset. Each reads `akm-cli/workspace` operations only,
and each has the same information as text beside it (a table or a list). The design behind them is
in [prototypes](prototypes/README.md).

## Run timeline (Activity, Runs)

A row per scheduled task, a row per workflow, then Improve and Index builds, on one clock: the
metrics window chosen on the page. A mark is where a run started. A circle finished, a triangle
failed, a diamond ended another way (blocked, still active, or no outcome recorded). A gap is a time
with no recorded run; nothing says whether a run was expected then. A task run's tooltip says
whether the schedule or a person started it. Selecting a task's mark opens its recorded runs;
selecting a workflow run's mark opens its trace. Table gives each row's counts and latest run.

It reads `activity.taskRuns` and `activity.workflowRuns` for the window, and `activity.overview` for
improve runs and index builds.

| Limit | Why |
| --- | --- |
| At most 20,000 task runs in a window | `activity.taskRuns` stops there and says so. |
| Improve shows its latest 10 runs, Index its latest 20 builds | `activity.overview` returns `improveRuns` (latest 10, all time) and `metrics.index.recent`. |
| A mark has no width | The vendored chart (bar, line, scatter) has no interval mark. A run's duration is in its tooltip. |
| A task run says schedule or by hand, not which workflow or script | akm records `trigger` (`schedule` or `manual`); a task started by a workflow step is `manual`. Runs recorded before this release say nothing. |
| Child workflow runs have no row | They are part of their parent's trace, which links to them. |

## Workflow run trace (Activity, Runs, a workflow run)

One run: its steps in order, then every unit on one clock, with a bar per attempt. A failed attempt
is hatched, a gate check by a judge has its own colour, and a running attempt ends at now. Selecting
a unit lists its attempts and what it reported. The Runs page also lists the window's workflow runs
as a table, each linking to its trace.

It reads `activity.workflowRun`, which is `akm workflow status --units` with each unit's attempts.

| Limit | Why |
| --- | --- |
| A step's span is its units' | akm records no start time for a step. |
| A run with no units shows its steps only | Units are journaled by the workflow engine as it dispatches them. |

## Link map (Library, an asset's Related tab)

The asset in the middle, what links to it on the left and what it links to on the right, grouped by
kind of link, with an arrow pointing at the target. A target AKM could not find is named, dashed,
and is not a link. "Add similar content" adds the nearest stored embeddings, dashed, because
similarity is not a recorded link. Each asset shown is a link to its own page.

It reads the `links` of `assets.show`, which the page already has, and `assets.related` when asked.

| Limit | Why |
| --- | --- |
| One step only | The library map shows the whole graph; this view stays on one asset. |
| At most 10 assets per kind and direction | `assets.show` returns ten refs per group and a total; the map says how many it was not given. |
| At most 20 similar assets | `assets.related` returns the 20 nearest. |

## Library map (Library, Map)

Every asset of the enabled bundles as a point and every declared link between them as a line, drawn
with WebGL so tens of thousands of assets stay interactive. Size is how often an asset is shown.
Colour is its type (eight families), its bundle, or its use. Two arrangements: by meaning, where
assets with similar stored embeddings sit together, and by bundle, a disc per bundle that needs no
embeddings. Search, hide a group, switch link kinds off, or highlight assets never shown or
superseded and contradicted. Selecting an asset lights it and what it links to and lists the links.
Table lists the same assets, most shown first, each linking to its page.

It reads `assets.graph`. The renderer is `src/lib/ui/graph-gl.js`, wrapped by `GraphView.svelte`; its
colours are the `--map-1` to `--map-8` tokens.

| Limit | Why |
| --- | --- |
| By meaning needs stored embeddings, and leaves out an asset without one | Positions are a projection of the stored vectors; the legend says how many assets are left out. |
| By meaning is a linear projection | `assets.graph` places assets on the three principal components of their embeddings. Groups overlap more than a non-linear layout would show. The components are found once per index build (under a second for 30,000 assets in testing) and reused after. |
| The table lists the 200 most shown matches | Search and filters narrow it. |
| Needs WebGL 2 | Without it the page says so and Table still works. |

## Activity replay (Activity, Replay)

The searches, reads and feedback of the last 24 hours or 7 days, played over the library map:
assets light up as they are used and stay lit, and a pulse from the one who made the event goes to
the asset (blue a read, green or red feedback). Below, a lane per agent harness (or, where none was
recorded, the event's source) shows how much happened when, with a lane for searches that found
nothing; the slider moves through the period. Beside it, the running totals, the latest events and
the searches that found nothing. With reduced motion it opens at the end of the period, paused.

It reads `assets.graph` and `activity.events`.

| Limit | Why |
| --- | --- |
| At most 20,000 events in a period | `activity.events` stops there and says so; the page says so too. |
| Older events have no agent | akm records the harness and session on usage events from this release. |
| "No agent recorded" mixes a person with an agent akm did not recognise | Both record source `user` and no harness. |
