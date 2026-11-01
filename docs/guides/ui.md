# The Local UI

`akm ui` opens a browser page on your own machine for reading the library, reviewing what improve proposes, and
changing settings. It serves only to `127.0.0.1` by default, and every launch has its own token. Browsing records no
usage, so looking at assets here never counts as demand. See [`akm ui`](../reference/cli.md) for the flags.

```sh
akm ui            # opens the browser
akm ui --no-open  # prints the URL instead
```

## The pages

| Page | What it answers |
| --- | --- |
| **Overview** | Is anything wrong, what needs me, and is search finding what I need? |
| **Proposals** | What improve wants to change, one diff at a time, with accept, reject and undo. |
| **Improve impact** | Did improve help? Who decided what, what was undone, and what it cost. |
| **History** | Every commit to the working stash, grouped by day, filterable by text and by who made it. |
| **Search** | Find an asset (Results), read the index (Browse), and see queries that found nothing (Misses). |
| **New knowledge** | Write a Markdown asset into a writable bundle. Existing files are never overwritten. |
| **Bundles** | Where akm reads from and writes to; add, update or remove a bundle. |
| **Config** | The settings akm keeps in `config.json`, each change validated as `akm config set` would. |

### Overview

The top line is the overall health of the last 24 hours: failing, warning and passing checks. A check the server could
not decide is never shown as "unknown". It sits in one of these groups, with its message:

- **Turned off**: a feature that is off, such as model features with no connection set up, or learning.
- **Not checked**: a check that contacts the akm release source or your scheduler. The page runs it only when you
  press **Run all checks**, so opening the page makes no outbound call.
- **Could not check**: a check that ran and could not finish. The message says why.
- **No data yet**: nothing has been recorded for it, for example no extraction in the last 7 days.

**Needs attention** lists what wants you, most severe first, each with a link to the place you fix it.
**Last 7 days against your usual** compares this week with the eight before it. "Usual" is the range the
weekly figure stays in by chance alone at your search volume, so a week outside it is worth a look and one inside
it is not. With too few searches the page says so instead of drawing a range.

**Trends** covers 30 or 90 days:

- the share of searches that found nothing, by week, with its usual range and the improve runs under it;
- searches per week and search time;
- your own searches, curates, shows and feedback by day;
- model calls by process, and scheduled tasks with failed runs.

Every chart has **Data and details** under it with the same figures as a table.

### Proposals

The queue is on the left, grouped by the process that made each proposal. Open one to see why akm proposed it
and the change itself, side by side or inline. **Accept** asks once more before it writes. **Reject** asks why, so
the reason teaches the next run. A decision can be undone from the confirmation or from **Recent**.

Tick proposals, or a group's heading box, to reject several with one reason. The line above the queue counts what
is waiting by age; select an age to show only those.

### Improve impact

Read the page top to bottom:

1. **Did improve help search?** The share of searches that found something, with a mark on each day an improve
   change was kept.
2. **Who decided what.** One bar per process: accepted by the judge or by you, rejected, reverted.
3. **Is review keeping up?** Proposals waiting at the end of each week, and how many were made and decided.
4. **Harm log.** Changes that were undone, rejections reopened, risky retirements and complaints after a change.
   It is never collapsed.
5. **Cost, changed assets, and the judge against you.**

### Search

Type and press Enter. **Filters** holds type, bundle, belief state, the result count and scope; when a filter is
on, its summary names it, so a narrowed search never looks like a full one. An empty query lists the index instead.
**Misses** lists queries that found nothing; each can become new knowledge.

### Assets and editing

An asset page shows the rendered document. The side rail shows its type, bundle, feedback for 90 days,
pending proposals and what improve has done to it. **Edit Markdown** opens the editor for writable knowledge and
memory. The editor refuses a save if the file changed on disk since you opened it, and keeps your draft.
**Feedback** records a helpful or not-helpful signal with a reason. A negative signal needs a reason, and it can
carry an exact fix with its source.

## Keyboard

| Key | Where | Does |
| --- | --- | --- |
| `Ctrl/Cmd+K` | anywhere | Focus search |
| `?` | Proposals | List every shortcut |
| `j` / `k` | Proposals | Next / previous proposal |
| `a` | Proposals | Accept (press again to confirm) |
| `r` | Proposals | Reject, then choose a reason |
| `u` | Proposals | Undo the decision just made |
| `x` | Proposals | Select this proposal for a batch |
| `[` / `]` | Proposals | Previous / next change in the diff |
| `Ctrl/Cmd+S` | Editor | Save |
| `Esc` | menus and dialogs | Close |

## Glossary

- **Found nothing**: a search that returned no result. It describes retrieval, not whether an answer was right.
- **Usual range**: the band a weekly share stays in by chance at that week's volume (a p-chart). A week outside it is
  marked "unusual".
- **Proposal**: a change improve has staged. Nothing in a bundle changes until it is accepted.
- **Judge**: the improve pass that can accept proposals without you, when you turned that on.
- **Reverted**: an accepted change that was undone later.
- **Flag after a change**: negative feedback on an asset after improve changed it.
- **Working stash**: the bundle new knowledge, memories and accepted proposals go to unless another write target is
  set.
- **Belief state**: which assets search keeps. `current` keeps active assets; `historical` keeps deprecated,
  contradicted, superseded and archived ones; `all` keeps both.
