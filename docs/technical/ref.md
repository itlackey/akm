# Ref Format

A `ref` is the identifier that `akm search` returns for local assets and `akm show`
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
| `type` | yes | Asset type: `script`, `skill`, `command`, `agent`, `knowledge`, or `memory`. |
| `name` | yes | Asset filename or path relative to the type directory. |

## Examples

- `script:deploy.sh`
- `skill:code-review`
- `knowledge:api-guide`
- `command:release`
- `agent:reviewer`
- `npm:@scope/pkg//script:deploy.sh`

## Origin

When present, `origin` narrows lookup to a specific installed source:

```text
npm:@scope/pkg//script:deploy.sh
github:owner/repo//knowledge:guide
```

When absent, `akm show` resolves the asset across stash sources in priority
order.

## Usage Notes

Consumers should use structured fields like `type`, `name`, and `origin` for
display, and pass the full `ref` string back to `show` as the lookup token.

## Viking URIs

`akm show` also accepts `viking://` URIs for remote OpenViking content. These
are not standard refs but remote resource identifiers.

## Deferred Simplification

Non-script refs for `command`, `agent`, and `knowledge` are now emitted in a
simplified canonical form that omits file extensions such as `.md`. The
resolver still accepts refs that include the on-disk filename with extension on
input, but normalizes returned refs to the extension-less form.
