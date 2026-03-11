# Ref Format

A `ref` is the opaque handle `akm search` returns for local assets and `akm show`
consumes.

Agents should not parse refs or construct them by hand. The intended flow is:

```text
search -> pick a hit -> pass its ref to show
```

## Shape

Refs currently use this wire format:

```text
[origin//]type:name
```

| Part | Required | Description |
| --- | --- | --- |
| `origin` | no | Identifies which installed kit or source owns the asset. Separated from the rest of the ref by `//`. |
| `type` | yes | Asset type: `script`, `skill`, `command`, `agent`, or `knowledge`. |
| `name` | yes | Asset filename or path relative to the type directory. |

## Examples

- `script:deploy.sh`
- `skill:code-review`
- `knowledge:api-guide`
- `command:release`
- `agent:reviewer`
- `npm:@scope/pkg//script:deploy.sh`

`tool` is accepted as an alias for `script` when reading refs, but emitted refs
normalize to `script`.

## Origin

When present, `origin` narrows lookup to a specific installed source:

```text
npm:@scope/pkg//script:deploy.sh
github:owner/repo//knowledge:guide
```

When absent, `akm show` resolves the asset across stash sources in priority
order.

## Why This Is Opaque

The ref format is implementation plumbing, not user-facing structure. `search`
returns a handle that already encodes whatever `show` needs. Consumers should
use structured fields like `type`, `name`, and `origin` for display, and use the
full `ref` only as the lookup token passed back to `show`.

## Deferred Simplification

Non-script refs for `command`, `agent`, and `knowledge` are now emitted in a
simplified canonical form that omits file extensions such as `.md`. The
resolver still accepts refs that include the on-disk filename with extension on
input, but normalizes returned refs to the extension-less form.
