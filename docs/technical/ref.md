# Ref Format

A `ref` is the identifier that `akm search` returns for assets and `akm show`
consumes.

Agents should not parse refs or construct them by hand. The intended flow is:

```text
search -> pick a hit -> pass its ref to show
```

## Asset Refs

Asset refs use this wire format:

```text
[origin//]type:name
```

| Part | Required | Description |
| --- | --- | --- |
| `origin` | no | Configured source name (e.g. `team`, `local`) that owns the asset. Separated from the rest of the ref by `//`. |
| `type` | yes | Asset type: `script`, `skill`, `command`, `agent`, `knowledge`, `workflow`, `memory`, `vault`, or `wiki`. |
| `name` | yes | Asset filename or path relative to the type directory. |

Asset refs are parsed by `parseAssetRef` in `src/core/asset-ref.ts`. The
grammar (spec Appendix A) is:

```text
asset-ref := [ origin "//" ] type ":" name
origin    := [A-Za-z0-9][A-Za-z0-9_-]*
type      := [a-z][a-z0-9-]*
name      := [^\x00/\\:]+
```

### Examples

- `script:deploy.sh`
- `skill:code-review`
- `knowledge:api-guide`
- `command:release`
- `agent:reviewer`
- `memory:deployment-notes`
- `vault:prod`
- `wiki:research/index`
- `team//script:deploy.sh`
- `npm:@scope/pkg//script:deploy.sh`

### Rejected

- `viking://skills/deploy` (URI scheme — not a valid asset ref)
- `skill:../../../etc/passwd` (path traversal)
- `github:owner/repo` (this is an install ref, parsed elsewhere)

## Install Refs (distinct grammar)

`akm add` and one-shot `akm clone` accept a different ref grammar. Install
refs locate an upstream kit to fetch; they are **not** asset refs and are
parsed by `parseRegistryRef` in `src/registry/resolve.ts`.

```text
install-ref := github-ref | git-url | npm-pkg | https-url | skills-sh-slug | local-path
```

Examples: `github:owner/repo#v1.2.3`, `git+https://gitlab.com/org/kit`,
`@scope/kit`, `https://docs.example.com`, `skills.sh:code-review`,
`./path/to/kit`.

The two parsers are intentionally distinct — each rejects the other's inputs.
Asset refs never carry URI schemes; install refs are not addressable through
`akm show`.

## Origin

When an asset ref includes an origin, `akm show` narrows lookup to that
configured source:

```text
team//script:deploy.sh
local//knowledge:my-notes
```

When absent, `akm show` resolves the asset across all configured sources.

## Usage Notes

Consumers should use structured fields like `type`, `name`, and `origin` for
display, and pass the full `ref` string back to `show` as the lookup token.

## Canonical Form

Non-script refs for `command`, `agent`, `knowledge`, `memory`, and `wiki` are
emitted in a simplified canonical form that omits file extensions such as
`.md`. The resolver still accepts refs that include the on-disk filename with
extension on input, but normalizes returned refs to the extension-less form.
