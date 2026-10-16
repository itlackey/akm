# `akm ui` API

The JSON API behind [`akm ui`](cli.md#ui). The page that `akm ui` serves uses only this API, and everything it
returns comes from the function the matching CLI command renders, so it never disagrees with the CLI. The API is
read-only apart from three proposal decisions: [accept](#post-apiproposalsidaccept), [reject](#post-apiproposalsidreject)
and [accept several](#post-apiproposalsaccept).

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
- **Methods.** `GET` (and `HEAD`) only, except the three `POST` routes under
  [Deciding proposals](#deciding-proposals-the-only-writes). Anything else is a `405` (after the token check).
- **Envelope.** Every response is JSON, `Cache-Control: no-store`:

  ```json
  { "ok": true, "data": { } }
  { "ok": false, "error": "Missing or invalid session token.", "code": "UNAUTHORIZED" }
  ```

  Errors raised by akm keep their stable `code` (`PROPOSAL_NOT_FOUND`, `ASSET_NOT_FOUND`, `INVALID_FLAG_VALUE`, ...).
  Status codes: `400` usage error (bad parameter), `401` token, `403` host or origin, `404` not found, `405` method,
  `409` conflict (writes only), `413` body too large, `415` content type, `503` transient (another akm process holds a
  lock; retry), `500` anything else. Codes the server itself raises: `UNAUTHORIZED`, `HOST_NOT_ALLOWED`,
  `ORIGIN_NOT_ALLOWED`, `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE`, `BODY_TOO_LARGE`, `INVALID_JSON_ARGUMENT`,
  `NOT_FOUND`, `INTERNAL_ERROR`.
- **Redaction.** Config values under secret-like keys (`apiKey`, `token`, `password`, `secret`, `credential`,
  `authorization`, anything under `env` or `secrets`) are `"[redacted]"`; symbolic references (`$VAR`, `secret://name`)
  are kept. Credentials inside any URL in any response (userinfo, `token=`, `api_key=`, `sig=`, ...) are masked. Env and
  secret assets are never read; see `/api/asset`.
- **Timestamps** are ISO 8601 UTC unless noted. Counts that cannot be computed are `null`, never `NaN`.
- **Read-only, except the three proposal writes.** Every `GET` opens `state.db` and `index.db` read-only and never
  creates or migrates them: a missing or behind-on-migrations `state.db` makes the sections that need it empty (and
  `health` report it as a failing check), not an error. Searching and showing record no usage events and build no index.
  Browsing writes nothing to a bundle, config or database.

The limit parameters (`limit`) are positive integers capped at 200.

## `GET /api/meta`

The running server and where it reads from.

```json
{
  "ok": true,
  "data": {
    "version": "0.10.261005",
    "runtime": "bun",
    "stashDir": "/home/me/akm",
    "dataDir": "/home/me/.local/share/akm",
    "configPath": "/home/me/.config/akm/config.json",
    "stateDbPath": "/home/me/.local/share/akm/state.db",
    "indexDbPath": "/home/me/.local/share/akm/index.db",
    "startedAt": "2026-10-16T15:41:15.716Z",
    "host": "127.0.0.1",
    "port": 39829
  }
}
```

`runtime` is `bun` or `node`. `stashDir` is `null` when no bundle is configured yet.

## `GET /api/overview`

Everything on the overview page in one call. Query parameters:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `since` | `24h` | Health window start (ISO, date, epoch ms, or `24h` / `7d`). A duration also turns on the prior-window comparison, as `akm health --report --since` does. |
| `metricsSince` | `30d` | Metrics window start, as `akm metrics --since`. |
| `probe` | off | `1` probes engine reachability and checks for a newer akm release (network). Off by default so loading the page makes no outbound calls. |

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
      "deltas": {},
      "report": {
        "window": "24h",
        "compare": "24h",
        "pendingProposals": [{ "ref": "stash//lessons/rg", "source": "reflect", "createdAt": "..." }],
        "acceptRateBySource": []
      }
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
    "usageByDay": [
      { "date": "2026-10-15", "search": 0, "curate": 0, "show": 0, "feedbackPositive": 0, "feedbackNegative": 0 },
      { "date": "2026-10-16", "search": 1, "curate": 0, "show": 1, "feedbackPositive": 1, "feedbackNegative": 1 }
    ]
  }
}
```

- `health` is what `akm health --report --group-by run` returns (`--no-probe` unless `probe=1`), minus the write: the
  `state-db-round-trip` check reports itself skipped. See [CLI: health](cli.md#health) for the check list and
  [`--format html`](cli.md#health) for how the report renders it. `windows`, `deltas` and `report.compare` are absent
  when `since` is an absolute date.
- `metrics` is what `akm metrics` returns (without `rows`); see [CLI: metrics](cli.md#metrics).
- `improveRuns` are the last 10 real (non-dry-run) improve runs, newest first. `preRunSync`, `sync` and `triage` are `null`
  when the run did not record them; `modelCalls` is empty for runs from before the usage report existed.
- `usageByDay` is the last 14 UTC days, oldest first, user-attributed events only (the same rule as ranking and
  `akm metrics`). Zero-filled.
- A section that fails is `null` (`[]` for the two lists) and named in a top-level `errors` object
  (`{ "errors": { "metrics": "..." } }`); the others still load. `errors` is absent when nothing failed.

## `GET /api/bundles`

One card per configured bundle, plus the index state. Git status is read from the repository as it is: nothing is
fetched, so `ahead`/`behind` are measured against the remote-tracking branch as the last `akm sync` left it.

```json
{
  "ok": true,
  "data": {
    "defaultBundle": "stash",
    "defaultWriteTarget": null,
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
- `git` is `null` unless the bundle's root is itself a git repository. `upstream`, `ahead` and `behind` are `null` without an
  upstream; `branch` is `null` on a detached HEAD; `lastCommit` is `null` for a repository with no commits. `dirtyPaths`
  counts paths with uncommitted changes.
- `index` mirrors `akm info`'s `indexStats` and `semanticSearch`. `embeddingCoverage` is embeddings over entries
  (`null` for an empty or missing index). `links`, `unavailable` and `unreadable` appear only when `akm info` reports them.

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
      "engines": { "default": { "kind": "llm", "endpoint": "https://llm.example.test/v1/chat/completions?token=%5Bredacted%5D", "model": "chat-model" } },
      "defaultBundle": "stash"
    },
    "entries": [
      { "path": "semanticSearchMode", "value": "off", "source": "file" },
      { "path": "output.format", "value": "json", "source": "default" }
    ],
    "engines": [{ "name": "default", "kind": "llm", "endpoint": "https://llm.example.test/v1/chat/completions?token=%5Bredacted%5D", "model": "chat-model" }],
    "env": [{ "name": "AKM_BUNDLE_DIR", "value": "/home/me/akm" }]
  }
}
```

- `config` is the redacted effective config tree. `entries` is the same data flattened to one row per leaf (arrays are
  leaves) with `source`: `default` (no config file sets it), `file` (this install's `config.json`),
  `extends:<ref>` (a config it extends), or `null` when the key cannot be traced (a key containing a `.`).
- `engines` is `config.engines` as a list. Reachability is a health probe, not config: use `/api/overview?probe=1`.
- `env` lists the `AKM_*` environment variables set for the server, which override paths and credentials. A
  secret-like name (`...KEY`, `...TOKEN`, ...) has `value: "[redacted]"`.

## `GET /api/proposals`

The proposal queue, as `akm proposal list` reads it. Query: `status=pending` (default) or `recent`, `limit` (default 100).

- `pending`: the pending queue, oldest-waiting first.
- `recent`: accepted, rejected and reverted proposals, most recently decided first.

```json
{
  "ok": true,
  "data": {
    "status": "pending",
    "totalCount": 3,
    "bySource": { "consolidate-pair": 2, "reflect": 1 },
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
- `waitingSince` is the last reopen, else creation: the age to show. `gateDecision` is the drain's or quality gate's
  verdict (`outcome`: `staged`, `auto-rejected`, `deferred`, ...; `reason` is a stable token). `review` is
  `{ outcome, reason?, decidedAt }` on a decided proposal.
- `retirement` is `null` unless the proposal retires an asset (`isRetire`). `continuityRisk` is
  `{ failingQueries, unverifiedQueries?, ranks }` when the continuity check flagged the pair, else `null`.
- Refs are durable `bundle//conceptId` refs.

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
      "targetPath": "/home/me/akm/lessons/rg.md"
    },
    "diffError": null
  }
}
```

- `proposal` carries the full metadata (everything `akm proposal show` prints) except content: the proposed text is in
  `diff.unified`, `payload.content` is omitted, and `changes` lists `{ op, path }` only. The prior content kept for
  `akm proposal revert` is never returned. The summary fields from the list are repeated, and `retirement` is the full
  record (with content hashes) on a retire proposal.
- `diff` is `null` and `diffError` says why when the target cannot be resolved (for example the bundle is no longer
  configured). For a retire proposal `unified` shows the file leaving and `retirement` has the successor.
- `validation` is the proposal validator's result; it does not run the accept preflight `akm proposal show` adds.

## Deciding proposals (the only writes)

Three `POST` routes accept or reject proposals. Each calls the function the CLI command calls (`akmProposalAccept`,
`akmProposalReject`, `akmProposalAcceptMany`) with the arguments the CLI passes, so a decision made here is recorded
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

A rejection can be undone with `akm proposal reopen`.

### `POST /api/proposals/accept`

Accept several pending proposals and commit them **once** (`akmProposalAcceptMany`, the call behind
`akm proposal accept <id> <id> ...`). The body is `{"ids": ["<id>", ...]}`: 1 to 200 non-empty strings; repeats are
dropped. An id that fails is reported and the rest carry on; what was accepted is committed either way. There is no
batch reject.

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

- `asset` is the show response in full (frontmatter fields such as `description`, `tags`, `toolPolicy`, the
  `content`, workflow `steps`, and so on depending on the type), and `links` groups declared links by kind
  (`outgoing`, `incoming`, `unresolved`). A missing ref is a `404` `ASSET_NOT_FOUND`.
- `feedback.counts` are all-time totals by signal across every source; `history` is the latest 50 events, newest
  first, with the feedback's `reason` and `tags` when it had them. Both are empty for an asset with no feedback or when
  `state.db` is unavailable. `durableRef` is the key feedback rows use, `null` when the asset is not indexed.
- **Env and secret assets are never read.** A ref of type `env` or `secret` returns only
  `{ "redacted": true, "type": "env", "ref": "env/prod", "note": "..." }`, with no `asset`, key names or values.
  Use `akm env list` for key names.
