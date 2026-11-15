# Visualizations

Desktop draws five pictures of what AKM records. None adds a metric: every mark is a recorded run, a
recorded event, a recorded link or an indexed asset. Each reads `akm-cli/workspace` operations only,
and each has the same information as text beside it (a table or a list). The design behind them is
in [prototypes](prototypes/README.md).

## Outcomes and the run views (Activity, Runs)

Above the timeline, one bar per kind of run (Improve, Tasks, Workflows) shows how its recorded runs of the window
ended: completed, failed or unknown, with the counts as text. A run with no recorded end (a task or workflow run still
active, blocked, or never finished) is unknown, never completed. "Terminated" is shown for an improve run whose record
says it was stopped (a signal or an exception, `activity.improveRun`'s `terminated`); a workflow run records no such thing
and an abandoned one is failed.

Each run opens in a view of its own, by its mark on the timeline, its row in a table, or an address:

| Run | Address | What it shows | Matched how |
| --- | --- | --- | --- |
| Workflow run | `?view=runs&run=<id>` | outcome, the failed attempts in the order they ended with their recorded reasons, tokens by execution target, then the trace | everything by run id |
| Task run | `?view=runs&task=<id>&at=<start>` | outcome, how long, who started it, the recorded reason, error and exit code; a link to the workflow run it ran | the workflow run by run id (`detail.runId`); an improve run started within five minutes, by time |
| Improve run | `?view=runs&improve=<id>` | outcome, times, usage by process, execution target and model (calls, failures, reported tokens), processes that made no call, whether it was terminated and why, the failed actions' recorded errors, sync and triage, and the error detail of the scheduled task run around it | the task run by time only (an `akm-improve*` or `improve` task within five minutes, the rule `akm doctor` uses); nothing carries an improve run's id |

| Limit | Why |
| --- | --- |
| An improve run is read by id when it is not among the latest 10 | `activity.overview` returns the latest 10; `activity.improveRun({ id })` returns any one. The "Improve run ID" field opens it. |
| An improve run's usage is its persisted report only | a run recorded before the report existed, or terminated before it, shows no usage: akm does not rebuild it from events, which carry no run id. A call that reported no tokens is "Not reported", not zero. |
| The error detail of the scheduled task run is matched by time | no record carries an improve run's id; the view says so, and a run started by hand has none. The run's own errors (failed actions, termination message) are read from its record. |
| A task run is identified by its task and start time | `activity.taskHistory` rows carry no id. |
| A workflow run shows the target of each unit, not its model | `activity.workflowRun` returns each unit's engine. |
| A workflow that failed with no failed attempt is not called terminated | akm records an abandoned run as failed; the view says it cannot tell which happened. |

## Run timeline (Activity, Runs)

A row per scheduled task, a row per workflow, then Improve and Index builds, on one clock: the
metrics window chosen on the page. A mark is where a run started. A green circle completed, a red triangle
failed, a grey diamond is unknown (blocked, still active, or no outcome recorded); a key sits above the chart. A gap is a time
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
marked "(missing)" and is not a link, here and on the Connections tab. "Add similar content" adds
the nearest stored embeddings, dashed, because similarity is not a recorded link: a column that
holds only similar content is headed "Similar, not linked", and an asset already shown as a link is
not repeated (the page says how many were left out). Each asset shown is a link to its own page.

It reads the `links` of `assets.show`, which the page already has, and `assets.related` when asked.

| Limit | Why |
| --- | --- |
| One step only | This view stays on one asset; the library map shows how the library's types and tags link. |
| At most 10 assets per kind and direction | `assets.show` returns ten refs per group and a total; the rest are counted ("and N more"). |
| At most 20 similar assets | `assets.related` returns the 20 nearest. |

## Library map (Library, Map)

The whole library, or one bundle (the bundle picker), as a mind map: the library in the middle, its asset types around
it, and on each type the tags its assets carry, every label drawn, with a bar under each tag for its figure. Three
views each answer one question, and each changes which tags are drawn, the lines between them and the lists beside the
map. Choosing a type or tag (on the map or by keyboard) draws lines from it to every other type and tag its assets are
joined to, fades the rest, and opens its answers in the column beside the map; Escape closes them.
`/library/map?select=<ref>` opens with that asset's tag chosen.

| View | Question | Tags drawn, ranked by | Lines from the chosen group | Beside the map |
| --- | --- | --- | --- | --- |
| Contents | What is in the library, and how does it connect? | assets | declared links and near-duplicates | what it is made of (bundles and types); how it connects; its most linked assets; other bundles that repeat it |
| Use | What is used, and what is dead weight? | reads (a tag with no reads is not drawn) | declared links and near-duplicates | the share read and never read, liked and disliked; most read; never read, longest unchanged first; searches of the last 90 days that found nothing and name one of its tags (from `assets.searchMisses`); how it connects |
| Problems | What is wrong or duplicated? | problems (a tag with none is not drawn) | `supersededBy`/`contradictedBy` links and near-duplicates | outdated assets (superseded, contradicted or deprecated); near-duplicates inside it and in other groups, with their cosine; disliked assets; how it connects; other bundles that repeat it |

A line's width is how many links and near-duplicate pairs join the two groups; its title gives both counts. An asset
with none of the drawn tags is counted under its type. Every listed asset opens its page, and Closest lists the assets
most alike in content (from `assets.related`), each with its cosine and a Compare link to the search page's comparison.

Use is reads by people and their agents inside the usage retention window (`use.since`), as `assets.graph` reports
them: scheduled tasks and Improve are not counted. When no usage history is available, the Use view says so instead of
calling every asset unread.

It reads `assets.graph`, `assets.searchMisses` and, on Closest, `assets.related`. The view model is
`src/lib/library-overview.ts`; the drawing is SVG (`src/lib/MindMap.svelte`), and the page is `src/lib/LibraryMap.svelte`.

| Limit | Why |
| --- | --- |
| About 44 tags in all, at most 10 per type | More labels cannot all be drawn and read; a type gets tags in proportion to the square root of its size, and a tag carried by one asset is left out of a type with ten or more assets. |
| Near-duplicates are pairs at a cosine of 0.96 or more, at most 2,000, and need stored embeddings | `assets.graph` compares only assets alike in meaning, to avoid comparing every pair; the threshold is set for akm's local embedding model. The page says when the list was cut. |
| Closest needs stored embeddings | Without them `assets.related` says so, and the page shows its note. |
| Old is the file's modification time | akm records no edit date; in a Git checkout the time is when the file was last written there. |
| Use covers the retention window only | Usage events older than the window are deleted, so an asset last read before it reads as not read. |

## Activity replay (Activity, Replay)

The searches, reads and feedback of the last 24 hours or 7 days, played over the library map. It
opens at the end of the period with every figure full, so the result is readable without playing;
Play starts again from the beginning and plays any period in about a minute (faster speeds are 4
and 16 times that). With reduced motion nothing flies or eases, and it stays paused at the end.

On the map an asset used so far is ringed in its type colour and every other asset is the faintest
mark; all points are one size. A pulse flies to an asset when it is read, returned by a search (a
hit, which does not count as use) or given feedback, each in its own colour and size (the
`--pulse-*` tokens, held apart from each other and from the type colours by
`tests/map-palette.test.mjs`). A key under the map names every mark. An asset with no position in
the arrangement is not drawn; its events still count, and the page says how many they were. Beside
the map: the running totals (other kinds of event, such as curate, have a total of their own, so the
totals add up to the lanes), the assets used most so far, the latest events and the searches that
found nothing.

Below, a lane per agent harness (or, where none was recorded, the event's source), with a lane for
searches that found nothing. Lanes run from the most events to the fewest and share one scale, which
is printed with the size of a slice; each lane shows its total. The time axis is labelled at its
start, middle and end, and the slider is as wide as the lanes. Every source is shown here, including
scheduled tasks and Improve, which the library map's use figures leave out.

It reads `assets.graph` once and `activity.events` for each period.

| Limit | Why |
| --- | --- |
| At most 20,000 events in a period | `activity.events` keeps the latest 20,000; the page says so and from when the replay therefore starts. |
| Older events have no agent | akm records the harness and session on usage events from this release. |
| "No agent recorded" mixes a person with an agent akm did not recognise | Both record source `user` and no harness. |
| Every point is one size | A replay is about one period, so it marks use with the ring only. |
