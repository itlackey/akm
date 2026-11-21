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

The whole library, or one bundle (the bundle picker, shown when there is more than one), under three questions:
Contents, Use and Problems. The questions sit on the Library's own tab row, and the map takes the rest of the window.
`/library/map?select=<ref>` opens with that asset's tag chosen. While the app is open the page remembers its question,
filter, bundle, drawing and chosen group, so opening an asset and coming back returns to the same place.

### The drawing

Three drawings of the same assets, switched on the map (Tags, 2D, 3D):

- **2D**, the default when the index holds groups by meaning (`assets.graph` `groups`, stored by `akm index`): every
  embedded asset is a point at the place `akm index` gave it, without its depth. Groups alike in meaning are near each
  other, and each is named by the tags its assets carry far more than the rest of the library. Position inside a group
  is approximate. A plane is read faster and more accurately than 3D, so it is where the map opens.
- **3D**: the same points with akm's depth; drag turns it. It separates groups that lie over each other in the plane.
  It needs WebGL (three.js, `src/lib/SimilarityMap.svelte`, which draws 2D too).
- **Tags**: the mind map of asset types and the tags their assets carry most, each tag with a bar for the question's
  figure (`src/lib/MindMap.svelte`). It is the only drawing when the index has no groups by meaning.

A change between 2D and 3D moves every mark to its new place over 0.6 seconds, and choosing a point or a group moves
the view to it over 0.7; with reduced motion both happen at once. The map opens with its points filling the frame.
Buttons on the map zoom and reset the view. With the map focused, the left and right arrow keys step through the
assets of the chosen point's group, and in 3D the up and down keys and Shift with left and right turn the view; + and −
zoom, and 0 faces the front.

| Question | Point colour | Point size | Filters |
| --- | --- | --- | --- |
| Contents: what is in the library? | its group by meaning | declared links | one per asset type; Not linked to anything; Repeated across bundles (with more than one bundle) |
| Use: what is used, and what is dead weight? | when it was last read | reads | Never read, untouched 6+ months; Read but disliked; Most read |
| Problems: what is wrong or duplicated? | its worst problem | reads | Outdated, still read; Near-identical pairs; Disliked; Outdated, unread |

A key on the map names the colours and the sizes. Only what the chosen filter finds is drawn to size; the rest is
faint and at one size.

### Filters

Each question has its own filters, drawn on the map as buttons with how many assets (or pairs) each finds; one is on
at a time, and choosing it again turns it off. Use and Problems open on their first filter that finds anything, which
is the work the question is asked for; Contents opens with none. A filter akm has no figures for (use without usage
history, feedback or near-duplicates when unavailable) is not offered. The chosen filter:

- draws what it finds in full and fades the rest, which stay in place;
- adds to each group's name how many of them it holds ("24 to retire");
- lists exactly those assets beside the map, each with the figure that decides it ("untouched 19 months",
  "superseded · 33 reads", "3 down, 0 up"), in the order its first line says, eight at a time with Show all;
- lists under them where they are by group, the most first.

Each listed asset opens its page, where it is edited or retired. Near-identical pairs are listed as pairs with how
alike they are and a Compare link to the search page's comparison.

Find by name or tag narrows every filter to the assets whose name and tags hold each word typed, and says how many
match. Choosing a group (its name on the map, or in the list) narrows the filters to that group, flies to it, draws
lines to the groups it is joined to and lists them; a dashed button beside the filters names the group and clears it.

### A chosen asset

Choosing a point (from anywhere over its disc, the one in front where several overlap; the point under the pointer is
ringed and named with its figures) replaces the list with that asset: its type and bundle, Open, Most similar (the
nearest content by embedding from `assets.related`, each with how alike and a Compare link), what is wrong with it
(outdated, with a link to the asset that replaced or contradicts it; disliked, with its feedback; nearly the same as
another, with Compare), its reads, when it was last edited, and what it is joined to. On the map it is ringed with a
halo and named by a label that stays over every other mark, the rest fades, and what it is joined to is drawn up to
three steps out, each level in its own width and colour with its assets ringed to match:

| Level | Reaches | Drawn |
| --- | --- | --- |
| 1st | the assets joined to the chosen one | widest line, the highlight colour, largest ring |
| 2nd | the assets joined to those | thinner line, more muted, smaller ring |
| 3rd | the assets joined to those | thinnest line, most muted, dashed, smallest ring |

The joins are the ones `assets.graph` reports (declared links and near-duplicate pairs; in Problems only replacement
and contradiction links and near-duplicates), either way round. Each join is drawn once, at the nearest level it
belongs to. A level shows at most 300 assets, the most joined first; the key on the map lists the levels that reach
anything and says what a level left out. The walk is `reach` in `src/lib/link-levels.ts`; each level's colour is held
at 3:1 against the background in both themes by `tests/map-palette.test.mjs`. Escape clears the choice.

Use is reads by people and their agents inside the usage retention window (`use.since`), as `assets.graph` reports
them: scheduled tasks and Improve are not counted.

It reads `assets.graph` and, on Most similar, `assets.related`. The view model is `src/lib/library-overview.ts`, and
the page, with each question's filters, is `src/lib/LibraryMap.svelte`.

| Limit | Why |
| --- | --- |
| About 44 tags in all on Tags, at most 10 per type | More labels cannot all be drawn and read; a type gets tags in proportion to the square root of its size, and a tag carried by one asset is left out of a type with ten or more assets. |
| A level shows at most 300 assets | Three steps from a well-joined asset can reach most of the library; the key says what a level left out. |
| Near-duplicates are pairs at a cosine of 0.96 or more, at most 2,000, and need stored embeddings | `assets.graph` compares only assets alike in meaning, to avoid comparing every pair; the threshold is set for akm's local embedding model. |
| Most similar needs stored embeddings | Without them `assets.related` says so, and the page shows its note. |
| Position inside a group is approximate | akm places a group's assets around its middle; Most similar gives the measured similarity. |
| 2D is not a second layout | It is the 3D place without its depth, so two assets far apart in depth can lie on top of each other. |
| Size is read roughly | Area is compared less exactly than position, and in 3D a nearer point also draws larger; the lists and labels give the figure. |
| "Untouched" is the file's modification time | akm records no edit date; in a Git checkout the time is when the file was last written there. |
| Use covers the retention window only | Usage events older than the window are deleted, so an asset last read before it reads as not read. |
| Retiring is done on the asset's page | The map lists what to retire and opens it; the retire action, with its checks, lives there. |

## Activity replay (Activity, Replay)

The searches, reads and feedback of the last 24 hours or 7 days, played over the library map. It
opens at the end of the period with every figure full, so the result is readable without playing;
Play starts again from the beginning and plays any period in about a minute (faster speeds are 4
and 16 times that). With reduced motion nothing flies or eases, and it stays paused at the end.

The map is drawn as Tags, the default, or as points in 2D or 3D (the switch on the map; the choice is kept until the
app closes). The map, the lists beside it and the timeline under it fit one window; the timeline stays at the foot of
the window, so the playhead is in view with the map whatever is scrolled.

- **Tags**: the library mind map, with the number of events on each type and tag so far. A type or tag appears, in its
  own place, once it has had an event.
- **2D**: the points of Library, Map in one plane, drawing only the assets used so far: an asset, and its group's
  name, appear when it is first used.
- **3D**: every asset with a group by meaning is a point; an asset used so far is in its type's colour and the rest
  are faint.

On the points (`src/lib/SimilarityMap.svelte`, the renderer Library, Map uses) an asset is ringed, for the next 0.75
seconds of playing at the speed chosen, when an event reads it, a search returns it (a hit, which does not count as
use) or gives it feedback, each in its own colour (the `--pulse-*` tokens, held apart from each other and from the
type colours by `tests/map-palette.test.mjs`); an asset the latest of several events touched in that moment takes the
colour of the latest. A curate's results and other kinds of event light the asset as used without a ring. A point's
size is the number of events on its asset over the whole period, so it does not change as the replay plays. A key
under the map names every mark. An asset with no group by meaning has no place on the points; its events still count
in the figures, and the page says how many events so far touched assets with no place, and how many touched assets
the index no longer lists. Without stored embeddings the points cannot be drawn, and the page says so.

Beside the map, the running totals on one line, then: the searches that found
nothing, each with Search again and Create; the assets used most so far; the feedback given so far, each with its
sign, its asset and when; and the latest events. Choosing a point, a group or a tag replaces these with what was
chosen and its events so far, each linking to its asset.

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
| Pulses ring an asset for 0.75 seconds of playing | At 16 times speed a ring marks the events of about a fifth of the period at once. |
