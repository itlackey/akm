# Ref Format

A `ref` is the identifier that `akm search` returns for items and `akm show`
consumes.

Agents should not parse refs or construct them by hand. The intended flow is:

```text
search -> pick a hit -> pass its ref to show
```

## Item Refs

Item refs use this wire format:

```text
[bundle//]conceptId[#fragment]
```

| Part | Required | Description |
| --- | --- | --- |
| `bundle` | no | Workspace bundle slug (e.g. `personal`, `team-catalog`) that owns the item. Separated from the rest of the ref by `//`. When omitted, the ref resolves against the containing bundle (content-internal refs) or, for CLI/API input, against `defaultBundle` and then the remaining bundles in installation-priority order. |
| `conceptId` | yes | Subdir-qualified item id: the placement subdirectory followed by the item's canonical name, `/`-separated, extension-stripped. Examples: `knowledge/http-caching`, `skills/code-review`, `scripts/db/migrate/run.sh`. |
| `fragment` | no | Export selector, separated by `#`. Selects a named export inside a concept. |

`type` is **no longer part of a ref**. Identity is a path (`subdir/name`), not a
`type:name` pair. The subdirectory *is* the type signal — `skills/deploy` and
`workflows/deploy` are distinct concepts that never collide.

Refs are parsed by `parseBundleRef` in `src/core/asset/asset-ref.ts`. The
grammar (normative spec §11.1) is:

```text
ref        := [ bundle "//" ] concept-id [ "#" fragment ]
bundle     := any run of non-space chars excluding : . # /
concept-id := path within the bundle, ext-stripped, / -separated, NFC, case-sensitive
fragment   := export selector
```

The bundle slug excludes `:`, `.`, `#`, `/`, and whitespace so a `bundle//conceptId`
token is lexically distinct from a URL (whose scheme carries a `:` before `//`) and
so the first `//` unambiguously bounds the bundle.

### Subdir-qualified concept ids

The subdirectory prefix is the item's placement directory:

| Subdir | Holds | Example conceptId |
| --- | --- | --- |
| `scripts/` | Executable scripts | `scripts/deploy.sh` |
| `skills/` | Skill directories (`SKILL.md`) | `skills/code-review` |
| `commands/` | Slash-command templates | `commands/release` |
| `agents/` | Agent definitions | `agents/reviewer` |
| `knowledge/` | Reference documents | `knowledge/api-guide` |
| `workflows/` | Workflow documents / programs | `workflows/ship-release` |
| `memories/` | Recalled context fragments | `memories/deployment-notes` |
| `lessons/` | Distilled feedback lessons | `lessons/retry-backoff` |
| `env/` | `.env` configuration groups | `env/prod` |
| `secrets/` | Single sensitive values | `secrets/deploy-token` |
| `tasks/` | Scheduled / on-demand tasks | `tasks/nightly-sync` |

### Examples

- `scripts/deploy.sh`
- `skills/code-review`
- `knowledge/api-guide`
- `commands/release`
- `agents/reviewer`
- `memories/deployment-notes`
- `env/prod`
- `personal//knowledge/http-caching`
- `team-catalog//workflows/release`
- `knowledge/api-guide#authentication` (export fragment)

### Rejected

- `viking://skills/deploy` (URI scheme — a `:` before `//` is not a bundle slug)
- `skills/../../../etc/passwd` (path traversal)
- `github:owner/repo` (this is an install ref, parsed elsewhere)
- the pre-0.9.0 `<type>:<name>` grammar (e.g. the old colon-typed spelling) — dead;
  parsed only by the frozen migrator

## Reserved structural files

`index.md` (directory listing / progressive disclosure) and `log.md` (update
history) are **reserved structural files at every level of a bundle** and are
never items. No adapter emits a ref for them, and item writes (`placeNew`,
`akm mv`, item write-transactions) refuse a reserved-filename target. They have no
conceptId, so no ref can name them — the grammar enforces this passively. Keeping
`index.md`/`log.md` in listing/log shape is bundle maintenance owned by the
bundle's adapter, never an item write.

## Install Refs (distinct grammar)

`akm add` and one-shot `akm clone` accept a different ref grammar. Install
refs locate an upstream kit to fetch; they are **not** item refs and are
parsed by `parseRegistryRef` in `src/registry/resolve.ts`.

```text
install-ref := github-ref | git-url | npm-pkg | https-url | skills-sh-slug | local-path
```

Examples: `github:owner/repo#v1.2.3`, `git+https://gitlab.com/org/kit`,
`@scope/kit`, `https://docs.example.com`, `skills.sh:code-review`,
`./path/to/kit`.

The two parsers are intentionally distinct — each rejects the other's inputs.
Item refs never carry URI schemes; install refs are not addressable through
`akm show`.

## Bundle prefix

When a ref includes a bundle prefix, `akm show` narrows lookup to that bundle:

```text
team-catalog//scripts/deploy.sh
personal//knowledge/my-notes
```

When absent, a short ref from CLI/API input resolves to `defaultBundle` if the
conceptId exists there, otherwise to the first bundle containing it in installation
priority order (first match wins, deterministically). A short ref inside bundle
content resolves against its **containing** bundle. To pin lookup to a single
bundle programmatically, use `resolveRef(input, { only: bundleId })` — there is no
ref spelling for "primary only".

## Usage Notes

Consumers should use structured fields like `conceptId` and `bundle` for display,
and pass the full `ref` string back to `show` as the lookup token.

## Canonical Form

Refs are emitted in canonical form: the bundle slug (when qualified), the
subdir-qualified conceptId with file extensions stripped (e.g. `.md`), and an
optional `#fragment`. The resolver still accepts refs that include the on-disk
filename with extension on input, but normalizes returned refs to the
extension-less form. Directory-items (skills) resolve on the directory path
(`skills/<dir>`, not `skills/<dir>/SKILL`).
