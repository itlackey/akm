# `akm ui` API

The JSON API behind [`akm ui`](cli.md#ui). The page that `akm ui` serves uses only this API, and everything it
returns comes from the function the matching CLI command renders, so it never disagrees with the CLI. The API is
read-only for browsing. Intentional writes use the finite [proposal decision](#deciding-proposals) and
[workspace action](#workspace-actions) routes below.

**Experimental** (see [STABILITY.md](../../STABILITY.md)). The shapes below are what 0.10 ships; they may change in any
release, and nothing outside the page should script against them. Use the CLI's `--format json` for that.

## Conventions

- Base URL: the one `akm ui` prints, `http://<host>:<port>/`. Every path below is under it.
- **Token.** Every `/api/` request must carry the launch token, as the `X-Akm-Ui-Token` header or a `token` query
  parameter. A missing or wrong token is a `401`. The page receives the token in its URL (`/?token=...`), keeps it in
  `sessionStorage`, drops it from the address bar and sends the header. Static files (`/`, `/app.js`, `/styles.css`) are
  served without a token and embed no data.
- **Host.** The `Host` header must be the address the server is bound to (`127.0.0.1:<port>` by default); anything else is
  a `403`. A server bound to a wildcard address (`--host 0.0.0.0`) also accepts IP-literal hosts on its port.
- **Methods.** `GET` (and `HEAD`) only, except the explicit `POST` routes documented below. Anything else is a `405` (after the token check).
- **Envelope.** Every response is JSON, `Cache-Control: no-store`:

  ```json
  { "ok": true, "data": { } }
  { "ok": false, "error": "Missing or invalid session token.", "code": "UNAUTHORIZED" }
  ```

  Errors raised by akm keep their stable `code` (`PROPOSAL_NOT_FOUND`, `ASSET_NOT_FOUND`, `INVALID_FLAG_VALUE`, ...).
  Status codes: `400` usage error (bad parameter), `401` token, `403` host or origin, `404` not found, `405` method,
  `409` conflict (writes, and the editor's `/api/asset/source` read), `413` body too large, `415` content type, `503`
  transient (another akm process holds a lock; retry), `500` anything else. Codes the server itself raises: `UNAUTHORIZED`, `HOST_NOT_ALLOWED`,
  `ORIGIN_NOT_ALLOWED`, `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE`, `BODY_TOO_LARGE`, `INVALID_JSON_ARGUMENT`,
  `NOT_FOUND`, `INTERNAL_ERROR`.
- **Redaction.** Config values under secret-like keys (`apiKey`, `token`, `password`, `secret`, `credential`,
  `authorization`, anything under `env` or `secrets`) are `"[redacted]"`; symbolic references (`$VAR`, `${secrets/name}`)
  are kept. Credentials inside any URL in any response (userinfo, `token=`, `api_key=`, `sig=`, ...) are masked. Env and
  secret assets are never read; see `/api/asset`.
- **Timestamps** are ISO 8601 UTC unless noted. Counts that cannot be computed are `null`, never `NaN`.
- **Read-only browsing.** Every `GET` opens `state.db` and `index.db` read-only and never
  creates or migrates them: a missing or behind-on-migrations `state.db` makes the sections that need it empty (and
  `health` report it as a failing check), not an error. Searching and showing record no usage events and build no index.
  Browsing writes nothing to a bundle, config or database.

The limit parameters (`limit`) are positive integers capped at 200.

## `GET /api/meta`

The running akm version, the machine's host name and the runtime.

```json
{
  "ok": true,
  "data": {
    "version": "0.10.261005",
    "hostname": "workstation",
    "runtime": "bun"
  }
}
```

`runtime` is `bun` or `node`. `hostname` identifies the machine running akm.

## `GET /api/overview`

Everything on the overview page in one call. Query parameters:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `metricsSince` | `30d` | Metrics window start, as `akm metrics --since`. |
| `probe` | off | `1` probes whether each connection's endpoint answers and what each harness's `--version` prints, and checks for a newer akm release (network). Off by default so loading the page makes no outbound calls. |

```json
{
  "ok": true,
  "data": {
    "health": {
      "schemaVersion": 3,
      "ok": true,
      "status": "pass",
      "since": "2026-10-15T15:41:20.499Z",
      "hardChecks": [{ "name": "state-db-schema", "kind": "deterministic", "status": "pass", "confidence": "high", "message": "...", "evidence": {} }],
      "advisories": [],
      "metrics": { "taskFailRate": 0, "agentFailureRate": 0, "stuckActiveRuns": 0, "llmUsage": {} },
      "improve": {},
      "runs": [],
      "windows": [{ "name": "current", "since": "...", "until": "...", "runs": 1, "improve": {}, "metrics": {} }, { "name": "prior" }],
      "deltas": {}
    },
    "metrics": { "schemaVersion": 1, "window": {}, "usage": {}, "feedback": {}, "utility": {}, "llm": {}, "proposals": {}, "notes": [] },
    "improveRuns": [
      {
        "id": "run-1",
        "startedAt": "2026-10-16T15:42:09.487Z",
        "completedAt": "2026-10-16T15:43:09.487Z",
        "ok": true,
        "durationMs": 60000,
        "strategy": "default",
        "scope": { "mode": "all" },
        "modelCalls": {
          "total": 5,
          "failures": 1,
          "byProcess": { "reflect": { "calls": 3, "failures": 1 }, "triage.judgment": { "calls": 2, "failures": 0 } }
        },
        "preRunSync": { "committed": false, "pushed": false, "skipped": true, "reason": "no remote" },
        "sync": { "committed": true, "pushed": false, "skipped": false },
        "triage": { "promoted": 2, "rejected": 1, "deferred": 0, "failed": 0, "skippedByCap": 0 }
      }
    ],
    "taskFailures": [{ "taskId": "weekly-review", "runs": 6, "failed": 2, "medianMs": 4000 }]
  }
}
```

- `health` is what `akm health --report --group-by run` returns (`--no-probe` unless `probe=1`), minus the write: the
  `state-db-round-trip` check reports itself skipped. See [CLI: health](cli.md#health) for the check list and
  [`--format html`](cli.md#health) for how the report renders it. The window is the last 24 hours, compared with the 24
  hours before it.
- `metrics` is what `akm metrics` returns (without `rows`); see [CLI: metrics](cli.md#metrics).
- `improveRuns` are the last 10 real (non-dry-run) improve runs, newest first. `preRunSync`, `sync` and `triage` are `null`
  when the run did not record them; `modelCalls` is empty for runs from before the usage report existed.
- Activity uses `metrics.usage.daily`, counting search/curate summary events rather than individual hits.
- `metrics.usage.searchMedianMs` uses recorded nonnegative durations (`totalMs >= 0`), like the daily latency median of
  [`/api/retrieval`](#get-apiretrieval). The daily feedback
  count in `metrics.usage.daily` counts signed rows only, like `metrics.feedback.totals`.
- `taskFailures` lists the tasks in `metrics.window` with at least one failed run, ordered as the page's bars are:
  failed runs over runs, highest first, then failed runs, then runs, then id, limited to 20. Nonfailed runs are not
  assumed successful, nor are absent runs evidence of a successful scheduled task.
  Details are available from `/api/tasks/history`. Missing/unreadable state yields `null` rather than a healthy empty list.
- Charts must retain `metrics.notes` about missing stores and retention; none of these series imply complete history.
  Improve runs remain the latest 10 across all dates, independently of the metrics window.
- A section that fails is `null` (`[]` for `improveRuns`) and named in a top-level `errors` object
  (`{ "errors": { "metrics": "..." } }`); the others still load. `errors` is absent when nothing failed.

## `GET /api/health`

The `health` part of `/api/overview` on its own, with the same `probe` parameter. The Overview calls it
with `probe=1` when you press **Run all checks**.

## `GET /api/tasks/history`

Requires `taskId`; optional `since` (default `30d`, same syntax as metrics) and `limit` (default 50, maximum 200).
Returns `{ available, totalCount, count, runs }`, newest first. Each run has
recorded `status`, `startedAt`, nullable `durationMs`, and nullable
decoded `detail` (`reason`, `error`, `exitCode`, `runId` when recorded). Invalid/missing historical detail stays
unknown. No log paths are returned or files read; these are existing state.db records. `available: false` means
state.db is absent or needs migration, not that this task has never failed.

## `GET /api/bundles`

One card per configured bundle, plus the index state. Git status is read from the repository as it is: nothing is
fetched, so `ahead`/`behind` are measured against the remote-tracking branch as the last `akm sync` left it.

```json
{
  "ok": true,
  "data": {
    "defaultBundle": "stash",
    "defaultWriteTarget": null,
    "workingStash": null,
    "bundles": [
      {
        "name": "stash",
        "kind": "filesystem",
        "default": true,
        "source": { "kind": "path", "locator": "/home/me/akm" },
        "path": "/home/me/akm",
        "writable": true,
        "version": null,
        "exists": true,
        "itemCount": 14,
        "byType": { "fact": 12, "knowledge": 2 },
        "git": {
          "branch": "main",
          "upstream": "origin/main",
          "ahead": 1,
          "behind": 0,
          "dirtyPaths": 0,
          "lastCommit": { "sha": "7591a50789d4cddc", "time": "2026-10-16T10:46:41-05:00", "subject": "akm save 2026-10-16 10:00:00" }
        }
      }
    ],
    "index": {
      "entryCount": 14,
      "byType": { "fact": 12, "knowledge": 2 },
      "lastBuiltAt": "2026-10-16T15:34:00.512Z",
      "hasEmbeddings": false,
      "embeddingCount": 0,
      "embeddingCoverage": 0,
      "semanticSearch": { "mode": "off", "status": "disabled" }
    }
  }
}
```

- `kind` is `filesystem`, `git`, `npm` or `website`. `source` describes where the bundle comes from; `path` is its local
  root (`null` if it has none).
- The default bundle's card comes first; the rest keep their configured order.
- `workingStash` is `{ path, git }` for the directory akm reads besides the configured bundles (`AKM_BUNDLE_DIR`, or the
  platform stash when no `defaultBundle` is set). `git` has the same shape as a card's `git`. It is `null` when a
  configured bundle already covers that directory or it cannot be resolved.
- `git` is `null` unless the bundle's root is itself a git repository. `upstream`, `ahead` and `behind` are `null` without an
  upstream; `branch` is `null` on a detached HEAD; `lastCommit` is `null` for a repository with no commits. `dirtyPaths`
  counts paths with uncommitted changes.
- `index` mirrors `akm info`'s `indexStats` and `semanticSearch`. `embeddingCoverage` is embeddings over entries
  (`null` for an empty or missing index). `unavailable` and `unreadable` appear only when `akm info` reports them.
- Cards also include `enabled`, the raw `writableSetting`, `settingsSource` and existing source `components`
  (`name`, `root`, `adapter`, optional explicit `writable`, and `configured`). Disabled bundles remain visible.
  Component overrides take precedence over the bundle writable default. An implicit/detected component is shown
  without creating new component configuration. Counts describe the existing index; they are not a live file catalog.

## `GET /api/bundle/files`

The local workspace browser lists one directory in an enabled registered bundle.
`bundle` selects its resolved content root; `path` is relative to it (default:
root); `hidden=1` includes dot-files. Absolute paths and symlink escapes are
refused. Internal symbolic links can be traversed; unavailable links are labelled.

The result is `{bundle, path, parent, indexAvailable, entries}`.
`parent` is null at the root. Each entry has `name`, bundle-relative `path`,
`kind` (`directory`, `file`, or `other`), and `assets: [{ref, type}]`,
with optional `symlink` and `unavailable`. Directories sort first, then names.
Internal links retain their displayed path and their target's indexed assets.
Assets come only from exact physical-file rows already in the index; absent
indexes leave them empty. No content is read, recursive scan run, index written,
or source refreshed. Listing does not imply editability.

## `GET /api/config`

The effective configuration, as `akm config list` shows it, with where each value comes from.

```json
{
  "ok": true,
  "data": {
    "path": "/home/me/.config/akm/config.json",
    "exists": true,
    "config": {
      "semanticSearchMode": "off",
      "connections": { "default": { "endpoint": "https://llm.example.test/v1?token=%5Bredacted%5D", "models": { "fast": "chat-model" } } },
      "harnesses": { "claude": {} },
      "defaultBundle": "stash"
    },
    "automaticWriteTarget": { "name": "stash", "path": "/home/me/akm", "workingStash": false },
    "entries": [
      { "path": "semanticSearchMode", "value": "off", "source": "file" },
      { "path": "output.format", "value": "json", "source": "default" }
    ],
    "connections": [{ "name": "default", "endpoint": "https://llm.example.test/v1?token=%5Bredacted%5D", "models": { "fast": "chat-model" } }],
    "harnesses": [{ "name": "claude" }],
    "env": [{ "name": "AKM_BUNDLE_DIR", "value": "/home/me/akm" }]
  }
}
```

- `config` is the redacted effective config tree. `entries` is the same data flattened to one row per leaf (arrays are
  leaves) with `source`: `default` (no config file sets it), `file` (this install's `config.json`),
  `extends:<ref>` (a config it extends), or `null` when the key cannot be traced (a key containing a `.`).
- `automaticWriteTarget` is `{ name, path, workingStash }` for where a write goes when `defaultWriteTarget` is empty:
  `AKM_BUNDLE_DIR` when set (even with a `defaultBundle`), otherwise the default bundle. `workingStash` is `true` when
  that directory is the one `/api/bundles` reports as the working stash. It is `null` when neither exists, so writes
  need a target.
- `connections` and `harnesses` are `config.connections` and `config.harnesses` as lists, each entry with its `name`
  and the entry's own keys (a connection's `endpoint` and `models`, a harness's `platform`, ...); keys are never
  included (`apiKey` shows as `[redacted]` or its `$VAR` reference). Reachability is a health probe, not config: use
  `/api/overview?probe=1`.
- `env` lists the `AKM_*` environment variables set for the server, which override paths and other settings. A
  secret-like name (`...KEY`, `...TOKEN`, ...) has `value: "[redacted]"`.

## `GET /api/proposals`

The proposal queue, as `akm proposal list` reads it. Query: `status=pending` (default) or `recent`, `limit` (default 100).
Optional `source` and `age` (`underDay`, `underWeek`, `older`, `unknown`) filter before applying the limit.
Age is less than one day, one to seven days, seven days or more, or an invalid/future date. It uses the most recent
reopen timestamp when present. `totalCount` is the filtered count; `fullCount` and `bySource` describe the full
selected status queue. `backlog` groups that full queue by source and these four age bands, before any list cap.
It is a current snapshot, not a time-series of historical queue size.

- `pending`: the pending queue, oldest-waiting first.
- `recent`: accepted, rejected and reverted proposals, most recently decided first.

```json
{
  "ok": true,
  "data": {
    "status": "pending",
    "totalCount": 3,
    "fullCount": 3,
    "bySource": { "consolidate-pair": 2, "reflect": 1 },
    "backlog": [{ "source": "consolidate-pair", "underDay": 2, "underWeek": 0, "older": 0, "unknown": 0 }, { "source": "reflect", "underDay": 0, "underWeek": 1, "older": 0, "unknown": 0 }],
    "proposals": [
      {
        "id": "d6bb7f94-69aa-48cf-9084-5dba2fa1afb3",
        "source": "consolidate-pair",
        "ref": "stash//knowledge/old-note",
        "status": "pending",
        "createdAt": "2026-10-16T15:46:41.896Z",
        "updatedAt": "2026-10-16T15:46:41.896Z",
        "waitingSince": "2026-10-16T15:46:41.896Z",
        "confidence": null,
        "gateDecision": { "outcome": "deferred", "reason": "judgment-deferred", "decidedAt": "..." },
        "review": null,
        "isRetire": true,
        "retirement": {
          "retiredRef": "stash//knowledge/old-note",
          "successorRef": "stash//knowledge/new-note",
          "reason": "duplicate",
          "judgeLabel": "duplicate",
          "judgeReason": "Same procedure, newer wording.",
          "cosine": 0.93,
          "onlyInRetired": [],
          "onlyInSuccessor": ["Adds the rollback step."],
          "continuityRisk": null
        }
      }
    ]
  }
}
```

- `totalCount` and `bySource` count the whole selection; `proposals` holds the first `limit`.
- `waitingSince` is the last reopen, else creation: the age to show. `decidedAt` is `null` while pending, else the
  decision time (a reverted proposal is dated by its accept). `gateDecision` is the drain's or quality gate's
  verdict (`outcome`: `staged`, `auto-rejected`, `deferred`, ...; `reason` is a stable token). `review` is
  `{ outcome, reason?, decidedAt, decidedBy? }` on a decided proposal; `decidedBy` is `triage` or `human` and is absent
  when the decider was not recorded (older decisions, system archives, reverts written before a revert kept its accept's
  decider): decider unknown.
- `retirement` is `null` unless the proposal retires an asset (`isRetire`). `continuityRisk` is
  `{ failingQueries, unverifiedQueries?, ranks }` when the continuity check flagged the pair, else `null`.
- Refs are durable `bundle//conceptId` refs.

Two further filters drill down from a chart: `week=YYYY-MM-DD` (a Monday) keeps proposals whose current decision was made
that ISO week (UTC), and `class=judge|you|unknown|rejected|reverted` keeps one outcome class. They combine with `source`
and `age`.

## `GET /api/proposals/:id`

One proposal, as `akm proposal show` plus `akm proposal diff`. `:id` is a proposal id, or an unambiguous prefix of a
pending one, or an asset ref (URL-encode it). Unknown: `404` `PROPOSAL_NOT_FOUND`.

```json
{
  "ok": true,
  "data": {
    "proposal": {
      "id": "d6bb7f94-69aa-48cf-9084-5dba2fa1afb3",
      "source": "reflect",
      "ref": "stash//lessons/rg",
      "status": "pending",
      "createdAt": "2026-10-16T15:46:41.896Z",
      "updatedAt": "2026-10-16T15:46:41.896Z",
      "waitingSince": "2026-10-16T15:46:41.896Z",
      "confidence": null,
      "gateDecision": null,
      "review": null,
      "isRetire": false,
      "retirement": null,
      "sourceRun": "run-1",
      "proposedTarget": { "source": "stash", "root": "/home/me/akm" },
      "payload": { "frontmatter": { "description": "Use ripgrep" } },
      "changes": [{ "op": "create", "path": "lessons/rg.md" }]
    },
    "validation": {
      "ok": true,
      "findings": [{ "kind": "invalid-description", "message": "...", "severity": "warn" }]
    },
    "diff": {
      "unified": "--- /dev/null\n+++ stash//lessons/rg (proposed, new asset)\n@@ 0,0 1,9 @@\n+---\n...",
      "isNew": true,
      "targetPath": "/home/me/akm/lessons/rg.md",
      "before": null,
      "after": "---\ndescription: Use ripgrep\n---\n\nPrefer rg over grep.\n",
      "truncated": false,
      "redacted": false
    },
    "diffError": null
  }
}
```

- `proposal` carries the full metadata (everything `akm proposal show` prints) except content: the proposed text is in
  `diff.unified` and `diff.after`, `payload.content` is omitted, and `changes` lists `{ op, path }` only. The prior content kept for
  `akm proposal revert` is never returned. The summary fields from the list are repeated, and `retirement` is the full
  record (with content hashes) on a retire proposal.
- `diff.before` and `diff.after` are the two texts the unified diff compares, read the same way (same target
  resolution as accept): the asset as it is now (`null` when the proposal creates it) and the content accept would
  write. The page lines them up itself, because the unified text pairs lines by position and so shows one inserted
  line as a rewrite of everything after it. Each is cut at 512 K characters; when either was, `truncated` is `true` and
  the page shows `unified` instead. For a retire proposal both are `null` (the file leaves; nothing is proposed). For an
  env or secret target both are `null`, `redacted` is `true` and `unified` is a one-line notice: their content is never
  returned.
- `diff` is `null` and `diffError` says why when the target cannot be resolved (for example the bundle is no longer
  configured). For a retire proposal `unified` shows the file leaving and `retirement` has the successor.
- `validation` is the proposal validator's result; it does not run the accept preflight `akm proposal show` adds.

## Deciding proposals

Six `POST` routes decide proposals. Each calls the function the CLI command calls (`akmProposalAccept`,
`akmProposalReject`, `akmProposalAcceptMany`, `akmProposalRevert`, `akmProposalReopen`) with the arguments the CLI passes, so a decision made here is recorded
exactly like `akm proposal accept` / `reject`: the same state.db rows and events, the same asset write and the same git
commit. No other path accepts anything but `GET`.

A write is refused unless **all** of these hold, checked in this order before the body is read:

| Requirement | Otherwise |
| --- | --- |
| The launch token in the `X-Akm-Ui-Token` **header**. A `?token=` query parameter does not count for writes. | `401 UNAUTHORIZED` |
| An `Origin` header equal to the server's own origin, `http://<host>:<port>` (the validated `Host`). A missing, `null`, other-host, other-port or `https` origin is refused, so another web page cannot make the browser send one. | `403 ORIGIN_NOT_ALLOWED` |
| `Content-Type: application/json` (a `charset` parameter is fine). | `415 UNSUPPORTED_MEDIA_TYPE` |
| A body of at most 65536 bytes (64 KB). | `413 BODY_TOO_LARGE` |
| A body that is valid JSON. | `400 INVALID_JSON_ARGUMENT` |

The `Host` guard applies as for every request (`403 HOST_NOT_ALLOWED`). The `X-Akm-Ui-Token` and `Origin` requirements are
the reason the page's own `fetch` works and a cross-site form post or script does not.

Failures from the decision itself keep the usual envelope. Codes and statuses:

| Status | `code` | When |
| --- | --- | --- |
| `400` | `MISSING_REQUIRED_ARGUMENT`, `INVALID_JSON_ARGUMENT`, `INVALID_FLAG_VALUE`, `INVALID_PROPOSAL`, ... | Bad input: no or empty reason, an `ids` list outside 1 to 200, a non-object body, a proposal that fails validation. |
| `404` | `PROPOSAL_NOT_FOUND` | No proposal has that id (or an ambiguous or unknown prefix). |
| `409` | `PROPOSAL_STALE` | The asset changed (or was created) after the proposal was made, so accepting would overwrite newer content. Nothing is written. |
| `409` | `PROPOSAL_NOT_PENDING` | The proposal was already accepted, rejected or reverted. |
| `409` | `ASSET_MUTATION_LEASE_HELD` | Another akm process (an `improve` run, the CLI) or request holds the write lease. Retry in a moment; the request does not wait. |
| `500` | `INTERNAL_ERROR`, other akm codes | Anything else. |

### `POST /api/proposals/:id/accept`

Accept one pending proposal. `:id` is a proposal id or unambiguous prefix. The body is `{}` (or empty).

```json
{
  "ok": true,
  "data": {
    "schemaVersion": 1,
    "ok": true,
    "id": "d6bb7f94-69aa-48cf-9084-5dba2fa1afb3",
    "ref": "stash//lessons/rg",
    "assetPath": "/home/me/akm/lessons/rg.md",
    "proposal": { "id": "d6bb7f94-...", "status": "accepted", "ref": "stash//lessons/rg", "...": "summary fields as in GET /api/proposals" },
    "commit": { "sha": "9f1c...", "time": "2026-10-16T16:02:11-05:00", "subject": "akm accept: reflect d6bb7f94 stash//lessons/rg", "repo": "/home/me/akm" }
  }
}
```

- `data` is `akmProposalAccept`'s result, with `proposal` reduced to the list summary (the prior content kept for
  `akm proposal revert` is never returned) and `commit` added.
- `commit` is the commit the accept just made in the bundle's repository, or `null` when the bundle is not a git
  repository (or the commit did not happen; a failed commit only warns, as in the CLI).

### `POST /api/proposals/:id/reject`

Reject one pending proposal. The body is `{"reason": "..."}`: required, a string, trimmed, 1 to 2000 characters, else
`400 MISSING_REQUIRED_ARGUMENT` (or `INVALID_FLAG_VALUE` when too long). The asset and the repository are untouched.

```json
{
  "ok": true,
  "data": {
    "schemaVersion": 1,
    "ok": true,
    "id": "d6bb7f94-69aa-48cf-9084-5dba2fa1afb3",
    "ref": "stash//lessons/rg",
    "reason": "Duplicates lessons/ripgrep.",
    "proposal": { "id": "d6bb7f94-...", "status": "rejected", "review": { "outcome": "rejected", "reason": "Duplicates lessons/ripgrep." } }
  }
}
```

A rejection can be undone with `akm proposal reopen`, and an accepted change with `akm proposal revert`; both are routes below.

### `POST /api/proposals/accept`

Accept several pending proposals and commit them **once** (`akmProposalAcceptMany`, the call behind
`akm proposal accept <id> <id> ...`). The body is `{"ids": ["<id>", ...]}`: 1 to 200 non-empty strings; repeats are
dropped. An id that fails is reported and the rest carry on; what was accepted is committed either way.

```json
{
  "ok": true,
  "data": {
    "accepted": 3,
    "failed": 1,
    "results": [
      { "schemaVersion": 1, "ok": true, "id": "...", "ref": "stash//lessons/a", "assetPath": "/home/me/akm/lessons/a.md", "proposal": { "status": "accepted" } },
      { "schemaVersion": 1, "ok": false, "id": "...", "error": "Proposal target changed after proposal ... was created; refusing to overwrite newer content.", "code": "PROPOSAL_STALE" }
    ],
    "commit": { "sha": "...", "time": "...", "subject": "akm proposal accept: 3 accepted (reflect 3)", "repo": "/home/me/akm" }
  }
}
```

- `results` follows the order of `ids`. A failed entry has `error` (akm's message) and a `code`: `PROPOSAL_STALE`,
  `PROPOSAL_NOT_PENDING`, `PROPOSAL_NOT_FOUND`, `ASSET_MUTATION_LEASE_HELD`, or `ACCEPT_FAILED` for anything else. The
  response is `200` even when some ids failed; a held lease fails the whole request with `409`.
- `commit` is the single commit for the batch (`null` when nothing was accepted or the bundle is not a git repository).

### `POST /api/proposals/reject`

Reject several pending proposals with **one shared reason** (`{"ids": ["<id>", ...], "reason": "..."}`, the same limits as
a single rejection and 1 to 200 ids). Each id is decided on its own through `akmProposalReject`, so a failure is reported
and the rest are still rejected. There is no undo for the batch; each rejected proposal can be reopened on its own.

```json
{ "ok": true, "data": { "rejected": 2, "failed": 1, "results": [
  { "ok": true, "id": "...", "ref": "stash//lessons/a", "proposal": { "status": "rejected" } },
  { "ok": false, "id": "missing-id", "error": "Proposal \"missing-id\" not found", "code": "PROPOSAL_NOT_FOUND" }
] } }
```

### `POST /api/proposals/:id/revert`

Undo an accepted change (`akmProposalRevert`, the call behind `akm proposal revert`): the target is restored from the
backup taken at accept, the proposal becomes `reverted`, and a target edited since acceptance is never overwritten. The
body is empty. A proposal that created a new asset has no backup and is refused. The summary carries `revertable`
(`true` for an accepted proposal that kept a backup) so a page can offer Undo only where it works.

### `POST /api/proposals/:id/reopen`

Return a rejected proposal to the pending queue (`akmProposalReopen`, the call behind `akm proposal reopen`). The body
is empty. A proposal that is not rejected, or whose target changed since, is refused with `400`.

The proposal summary gains two fields: `revertable` (above) and `decider` (`"triage"` for the judge, `"human"` for a
person, `null` for a decision recorded before `decidedBy` existed).

## `GET /api/changes`

Recent commits of the write-target stash (`defaultWriteTarget`, else the default bundle), from its git log. Query:
`limit` (default 50).

```json
{
  "ok": true,
  "data": {
    "bundle": "stash",
    "path": "/home/me/akm",
    "git": true,
    "commits": [
      {
        "sha": "7591a50789d4cddc89ab53ef9bdb2dfc9863444",
        "shortSha": "7591a507",
        "time": "2026-10-16T10:46:41-05:00",
        "author": "akm-test",
        "subject": "akm save 2026-10-16 10:00:00",
        "origin": "sync",
        "paths": ["knowledge/more.md"],
        "pathCount": 1
      }
    ]
  }
}
```

- `git` is `false` and `commits` empty when the stash is not a git repository.
- `origin` is derived from the subject, which is how akm names its own commits:

  | `origin` | Subject |
  | --- | --- |
  | `improve-sync` | `akm improve ...` (the pre-run sync and the end-of-run auto-sync) |
  | `accept` | `akm accept: ...`, `akm proposal ...` (including `akm proposal drain: N accepted ...`) |
  | `remember` | contains `remember` |
  | `sync` | `akm save ...`, `akm sync ...` |
  | `other` | anything else, such as a hand-made commit |

- `paths` lists at most 50 changed paths; `pathCount` is the real number. `time` is the commit's own committer date with
  its offset.

## `GET /api/search`

`akm search`, with the same results for the same inputs. Query:

| Parameter | Meaning |
| --- | --- |
| `q` | The query. Empty lists everything, as `akm search` with no query does; a trailing-slash prefix (`memories/projecta/`) enumerates a subtree. |
| `type` | Asset type filter (`knowledge`, `skill`, `memory`, ...), exact match. |
| `bundle` | Narrow to one configured bundle (`akm search --from <name>`). Unknown names are a `400`. |
| `belief` | `current` (default), `all`, or `historical`, forwarded to the existing search policy. |
| `scope_user`, `scope_agent`, `scope_run`, `scope_channel` | Existing exact scope filters; blank values are omitted. |
| `limit` | Maximum hits. Default 20. |

`data` is the search function's own response (what `akm search --format json` shapes down for the terminal), unshaped:

```json
{
  "ok": true,
  "data": {
    "schemaVersion": 1,
    "bundleDir": "/home/me/akm",
    "source": "local",
    "hits": [
      {
        "type": "knowledge",
        "name": "deploy",
        "path": "/home/me/akm/knowledge/deploy.md",
        "ref": "knowledge/deploy",
        "origin": "stash",
        "editable": true,
        "description": "Deploy guide",
        "tags": ["deploy"],
        "size": "small",
        "action": "akm show knowledge/deploy -> read reference material",
        "score": 0.016393,
        "whyMatched": ["lexical rank 1"],
        "estimatedTokens": 24,
        "quality": "generated"
      }
    ],
    "searchMode": "keyword",
    "tip": "...",
    "warnings": ["..."],
    "timing": { "totalMs": 4, "rankMs": 1, "embedMs": 1 }
  }
}
```

`tip` and `warnings` appear when there is something to say (an empty index, a stale one). Pass a hit's `ref` to
`/api/asset`. Registry results are never included, and no search is counted as demand.

## `GET /api/asset`

`akm show`, plus feedback. Query: `ref` (required), `[bundle//]conceptId[#fragment]` as `akm show` takes it.

```json
{
  "ok": true,
  "data": {
    "redacted": false,
    "durableRef": "stash//knowledge/guide",
    "asset": {
      "type": "knowledge",
      "name": "guide",
      "path": "/home/me/akm/knowledge/guide.md",
      "ref": "knowledge/guide",
      "origin": "stash",
      "editable": true,
      "action": "Reference material - read the content below. ...",
      "content": "---\ndescription: Deploy guide\n---\n# Deploy guide\n...",
      "links": { "outgoing": { "xref": { "total": 1, "refs": ["knowledge/notes"] } } }
    },
    "feedback": {
      "counts": { "positive": 1, "negative": 1 },
      "history": [
        { "at": "2026-10-16T15:46:41.000Z", "signal": "negative", "source": "user" },
        { "at": "2026-10-16T15:46:41.000Z", "signal": "positive", "source": "user", "reason": "clear", "tags": ["code:x"] }
      ]
    }
  }
}
```

- `asset` is the show response in full (frontmatter fields such as `description`, `tags`, `modelHint`, the
  `content`, workflow `steps`, and so on depending on the type), and `links` groups declared links by kind
  (`outgoing`, `incoming`, `unresolved`). A missing ref is a `404` `ASSET_NOT_FOUND`.
- `feedback.counts` are all-time totals by signal across every source; `history` is the latest 50 events, newest
  first, with the feedback's `reason` and `tags` when it had them. Both are empty for an asset with no feedback or when
  `state.db` is unavailable. `durableRef` is the key feedback rows use, `null` when the asset is not indexed.
- **Env and secret assets are never read.** A ref of type `env` or `secret` returns only
  `{ "redacted": true, "type": "env", "ref": "env/prod", "note": "..." }`, with no `asset`, key names or values.
  Use `akm env list` for key names.

The response also supplies `location` (`{bundle, path, parent}` relative to the
resolved bundle root, or null), `feedbackRequireReason`, the owning `bundle`, `headings` with existing AKM fragment
selectors, and a `links` map for supported relative inline Markdown links. A relative `.md` target must already be
indexed in the same bundle. Missing/out-of-bundle paths remain text; no arbitrary-file endpoint is added. Explicit
cross-bundle refs remain available. Relative images, uploads, universal title/alias resolution and unsupported
Markdown extensions are not provided. The client renders basic tables and disabled task-list checkboxes; raw HTML
is always escaped. Heading links use the UI router's `section` parameter.

## `GET /api/asset/source`

Query: `ref` (required, without a fragment). Returns `{ref, type, content, revision}` for an indexed, enabled, writable
AKM single-file asset: every type except `env`, `secret` and `session` (a skill is its `SKILL.md`; a skill's other files
are not assets and are refused). `content` is the full live UTF-8 source, including frontmatter; `revision` is its
SHA-256 over raw source bytes, independent of the indexed hash. The same authorized indexed-file resolution used by
`show` applies. Unsupported adapters, read-only targets, stale target identities and invalid UTF-8 are refused, with the
statuses of [workspace actions](#workspace-actions): a read-only bundle is `409`, not `500`.
The UI also refuses source editing when URL redaction would change its contents, so saving never replaces hidden
credentials with their displayed redactions. This route does not prepare a Git boundary, fetch or write anything.

## `GET /api/asset/related`

Query: `ref` (required), `scope` (`all`, the default, or `bundle` for the asset's own bundle). The assets whose stored
embeddings are nearest to this asset's, best first: `{available, note, matches: [{ref, title, type, cosine}]}`, at most 20.
Only stored vectors are read: no query is embedded and nothing leaves the machine. `available` is `false`, with a `note`,
when there is no index, the asset has no stored embedding, or its embedding belongs to an older model than the index's
current one (re-index first). Matches follow search's entry filter (enabled bundles, no proposed-quality entries) and never
include the asset itself or `env`, `secret` and `session` assets. A redacted asset has no related content.

## `GET /api/asset/history`

Query: `ref` (required), `limit` (default 30, maximum 200), optional `revision` chosen from the returned commit IDs.
Returns `{available, commits, diff?}` using the same Git summary shape as `/api/changes`, scoped to this file.
`diff` contains `before`, `after`, `unified`, `truncated`; sides/patches are capped at the existing 512 × 1024 character diff limit.
History is unavailable for non-Git bundles and protected env/secret assets. Unknown Git expressions or commit IDs
outside the returned file history are refused. No fetch, restore, rename tracking or additional version store exists.

## `GET /api/asset/improve`

What improve proposed for one asset and how the asset has been used since. `?ref=<bundle>//<type>/<name>` is required
(`400` without it).

- `proposals`: each proposal for the ref, newest first: `id`, `source`, `status`, `outcome` (`judge`, `you`, `unknown`,
  `rejected`, `reverted` or `pending`), `createdAt`, `decidedAt`.
- `usageByWeek`: the last 90 days by ISO week (Monday, UTC): `hits` (searches and shows that returned the asset),
  `positive` and `negative` feedback.
- `feedback`: the ten most recent signals with their reasons.

## `GET /api/fs/folders`

The sub-folders of one absolute folder, for the UI's folder picker. `?path=` is an absolute path or `~` (default: the home
folder); `?hidden=1` includes dot-folders. It lists folders only, never files, and follows a symbolic link only when it
points at a folder. A relative path or a file is `400`; a path that does not exist is `404`.

```json
{ "ok": true, "data": { "path": "/home/me/work", "parent": "/home/me",
  "folders": [{ "name": "skills", "path": "/home/me/work/skills" }], "truncated": false } }
```

`truncated` is `true` when the folder holds more than 500 sub-folders and the list was cut.

## `GET /api/improve/impact`

What improve proposed and changed, week by week. `?since=90d` (default) or `365d` (one year). Each store read (`proposals`,
`reopened`, `library`, `usage`, `cost`) stands on its own: one that fails reads as empty and is named under `errors`, and the
rest is still returned. When the state database is unavailable the response is `{ "available": false }`.

A proposal that was later reverted is dated by its accept (`acceptedAt`) in `outcomes`, `reviewFlow`, `changedAssets` and
`summary.kept`, and keeps the decider of its accept in `judgeAndYou`. The revert itself is the `reverted` entry of `harm`.

- `summary`: `kept`, `reverted` (the count of `harm` entries of that kind), `flags` (negative feedback within 14 days after a change), `tokens`, `tokenCoverage`
  (the share of model calls that reported tokens) and `checked` (decisions in the window).
- `outcomes`: per process (`source`), per week, the decisions by class: `judge`, `you`, `unknown`, `rejected`, `reverted`.
- `reviewFlow`: per week, proposals `created`, `decided`, and `waiting` at the end of the week.
- `library`: per week, the library size at the last index (`entries`, `null` before the index recorded it).
- `harm`: the log, newest first: `reverted`, `reopened`, `risky-retirement`, `flag-after-change`.
- `cost`: per week, model `calls`, `tokens`, `usageCalls` and calls by process.
- `changedAssets`: for each accepted change, how often the asset was found and rated in the 28 days before and after
  (`complete` is `false` until 28 days have passed since the change).
- `judgeAndYou`: accepted, rejected and reverted counts by who decided.

## `GET /api/overview/pulse`

The last seven days against the eight weeks before them, the four-week improve line, and what needs attention.

- `tiles.foundNothing`: `x` of `n` user searches found nothing; `usual` is the central 95% range of that share at this
  sample size (`state`: `within`, `above`, `below`, or `low-data` when the baseline has fewer than 30 searches or this week
  fewer than 10).
- `tiles.negativeFeedback`: `count`, `assets`, `latest`, and a `usual` weekly range (`state: "low-data"` with fewer than
  four weeks of data).
- `tiles.runs`: improve and task runs that finished ok, and the latest failed tasks.
- `improveLine`: proposals made in the last four weeks and what became of them.
- `attention`: `pending` (stash-scoped, not windowed), `misses`, `failedRuns`, `harm`, and `setup` when no model
  connection is configured.

## `GET /api/retrieval`

The per-day user search series (`?since=90d` by default): days inside the data's
coverage are filled with zeros, and the first and last day are marked `partial`. Each day has `searches`, `zeroResults`,
and `medianMs`. The median uses only recorded nonnegative durations; no samples means `null`, not
zero. Missing result counts do not mean zero results. The queries behind `zeroResults` are listed by
[`/api/search/misses`](#get-apisearchmisses).

`weekly` is the same data by ISO week as a p-chart: per week `week`, `x` (found nothing), `n` (searches), `rate`, and the
control limits `lower` and `upper` (centre ± 3 standard errors at that week's own n); `signal` is `true` for a week
outside its limits. A week with no searches has `null` for all three. `centre` is the pooled share.

## `GET /api/search/misses`

User searches that found nothing, grouped by normalised query: `query`, `count`, `days` (distinct UTC days),
`lastAt` and `repeated` (`true` when it came up on two or more days). `?since=30d` by default. The response also carries
`searches` (all user searches in the window) and `foundNothing`.

## Workspace actions

The workspace dispatchers also accept `POST /api/asset/retire` with
`{ref, revision}`. It retires an indexed writable AKM single-file asset the way
`akm feedback`'s typed fix applies a change: it mints a retire proposal (source
`propose`, no judged pair) and accepts it at once, so the asset follows the
ordinary proposal-retire lifecycle. Skill packages, env/secret files and
sessions are excluded; memory retirement carries its derived twin. The
current raw SHA-256 `revision` is required, and the accept is refused if the
bytes changed since.

The receipt is `{proposalId, ref, bundle, archiveDirs, warnings}`. Undo is
[`POST /api/proposals/:id/revert`](#deciding-proposals) with that id: the
archive moves back without overwriting an occupied path and its tombstone is
removed. Like any accepted retirement, the archived bytes are purged after the
grace period at the next `akm improve` (git-backed bundles only), and the row
is listed in Review and Activity. If the accept is refused, the proposal is
rejected and the request fails. Task definitions do not change installed
schedules until explicit `akm task sync`. The browser UI does not add controls
for this operation.

Every route below uses the same write guards as [proposal decisions](#deciding-proposals): token **header**, same
Origin, JSON content type and a body of at most 64 KiB. The two routes that carry a whole Markdown document,
`/api/asset/save` and `/api/knowledge/create`, take a body of up to 8 MiB (8388608 bytes); a larger one is
`413 BODY_TOO_LARGE`. Successful actions refresh the displayed data; failures stay beside the inputs. There is no
general config editor or command-execution endpoint.

| `POST` route | Body and existing operation |
| --- | --- |
| `/api/feedback` | `{ref, signal: "positive"\|"negative", reason?, tags?: string[]}` → `akm feedback`. The ref is passed to `akm feedback` as given, which resolves it as the CLI does; tags follow existing `key:value` validation. Negative feedback requires a reason when `feedback.requireReason` is enabled. Submissions are recorded with source `user` unless the server runs with an `AKM_EVENT_SOURCE` already set (for example under an improve or task run), which wins as it does for every akm child; they retain existing ranking/utility/event effects. Feedback does not save config, so it works under a config that still holds a literal API key. No fix, supersession or model flags are exposed. |
| `/api/bundles/add` | `{source, name?, writable?}` → `akm bundle add`, including source validation. Existing provider restrictions apply; no insecure-transport bypass is exposed. |
| `/api/bundles/update` | `{bundle}` → `akm bundle update -- <bundle>`. Fetches/reindexes only on explicit submission. A rare update requiring destructive confirmation remains refused; the UI does not silently pass `--yes`. |
| `/api/bundles/rename` | `{bundle, name, dryRun?: true}` → `akm bundle rename [--dry-run] -- <bundle> <name>`. The result is the CLI's rename plan (`applied` is `false` for a dry run). |
| `/api/bundles/remove` | `{bundle, confirm: true}` → `akm bundle remove --yes -- <bundle>`. The UI requires an inline confirmation before this call. Managed installs may be deleted; local filesystem source files remain on disk. |
| `/api/bundles/settings` | `{bundle?, enabled?, writable?, componentWritability?: {existingComponent: boolean}}` → existing schema-walking config setters inside `mutateConfig`. Only changed controls are submitted. Existing validation rejects disabled targets and writable npm/website sources. The default bundle and write target are edited through `/api/config/set`. |
| `/api/config/set` | `{set?: {key: string}, unset?: string[]}` → `akm config set` / `unset` on each key, in one validated, atomic write. Values are strings, as on the command line, and are coerced and checked against the schema; literal API keys and `configVersion` are refused. An unset is refused with `400 TARGET_NOT_UPDATABLE` when the key is inherited from an `extends` base or sits inside a connection or harness entry akm ignores, and an unset with no config file writes nothing (`saved: false`), all as `akm config unset` does. |
| `/api/knowledge/create` | `{bundle, name, path?, content}` → `akm import -` with Markdown on stdin. Uses the existing writable AKM target, name/path validation, frontmatter preservation, index/Git effects, and no `--force`. Existing files are never overwritten. Fails fast with `409 ASSET_MUTATION_LEASE_HELD` while another writer holds the asset-mutation lease. |
| `/api/asset/save` | `{ref, revision, content}` → the asset writer, for any asset `/api/asset/source` accepts. Knowledge and memory use the shared Markdown writer (`force`, expected raw-content hash); every other single-file type is written by the ordinary asset writer (Markdown gets its `type`/`updated` frontmatter, as on any akm write; the file mode is kept), committed on a Git bundle and indexed. The write takes the asset-mutation lease and compares the live source with `revision` inside it, immediately before writing, and refuses a path that passes through a symbolic link. While another writer holds the lease the save fails fast with `409 ASSET_MUTATION_LEASE_HELD` instead of waiting. A stale revision returns `409 ASSET_CONTENT_CHANGED` without writing; a source deleted after it was loaded is refused (`404 ASSET_NOT_FOUND`) rather than recreated. The browser keeps the draft after a rejected save. An identical save returns `unchanged: true` without rewriting, reindexing or recording an event. Changed saves retain normal writer validation, indexing and Git effects. |

Configuration-affecting actions do not round-trip the redacted API configuration. Existing mutation helpers retain
unknown/unrelated fields, local overrides and supported `$VAR`/`${ref}` credential references. If the existing
config sanitizer would remove unrelated legacy literal credentials, a bundle add or remove, or a settings change that
would write config, is refused with `400 INVALID_FLAG_VALUE` and the user is asked to correct those settings through
the CLI first. A settings request that changes nothing writes nothing and is not refused. It never writes
`"[redacted]"` back as a credential. Bundle update writes only the lockfile, and feedback, knowledge creation and
document editing do not save config, so none of them use that config-sanitizer check. Unsetting an inherited
`defaultBundle` or `defaultWriteTarget` through `/api/config/set` is refused with `400 TARGET_NOT_UPDATABLE`, as `akm config unset` refuses it.

The shared Markdown writer now participates in the existing mutation lease, including CLI import/remember callers;
omitting the optional expected hash retains their normal write/force behavior. This serializes cooperating AKM
writers; an external editor does not acquire AKM's lease. There is no lock held while a user edits a draft.
Untouched source preserves exact bytes, including leading newlines and mixed line endings. Actual edits preserve
uniform CRLF line endings; the browser normalizes mixed line endings to LF when the text is changed.

Failures keep the `code` the operation raised (for a child command, the code in its JSON error). Statuses:

| Status | When |
| --- | --- |
| `400` | A usage error: bad input, or a child that exits `2`. |
| `404` | Not found: an unknown asset or a deleted source, or a child that exits `1`. |
| `409` | A refusal the user can address: a stale revision (`ASSET_CONTENT_CHANGED`), a held asset-mutation lease (`ASSET_MUTATION_LEASE_HELD`) or another transient error (a child that exits `75`), or a config refusal such as a read-only bundle (`INVALID_CONFIG_FILE`, or a child that exits `78`). |
| `500` | A child that exits `70`, is killed or cannot start, any other error akm does not classify, and `INVALID_COMMAND_RESPONSE` below. |

A child command that exits zero without a valid expected JSON result returns `500 INVALID_COMMAND_RESPONSE`.
Its side effects may already have happened; reload before retrying. The UI never automatically repeats the action.
Historical restore and media ingestion remain separate work.
