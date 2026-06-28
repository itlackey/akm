# Implementation Plan: `vault` → `env` asset type refactor (0.8.0)

> Status: ✅ Shipped in 0.9.0 (`vault` removed; `env`/`secret` asset types live). Derived from the multi-agent design debate (see synthesis in
> the workflow transcript). Decisions locked by the repo owner:
>
> - **Scope:** full rename now (new `env` type + `vault` deprecation shim + copy-migration in 0.8.0).
> - **Canonical name:** `env` — ref `env:<name>`, directory `<stash>/env/`, renderer `env-file`.
>   `environment:` and `vault:` are accepted parse aliases through 0.9.0 (`vault:` warns to stderr).
> - **Deprecated `vault set`/`vault unset`:** hard-error with a signpost (no silent writer).
> - **`vault` verb removed entirely in 0.9.0.**

## Core principle: harden the read path BEFORE deleting the write path

The single most important sequencing constraint. Today `akm vault path` (cli.ts:2206)
prints the **raw** `.env` path and the docs recommend `source "$(akm vault path …)"`.
That is shell-safe *only because* `quoteValue`/`setKey` are the sole sanctioned writers —
`buildShellExportScript` (the safe exporter) exists but is **not wired to `path`**.

If we delete the write-side sanitizer while raw sourcing is still the documented idiom,
a hand-edited or migrated `.env` containing `X=$(rm -rf ~)` executes arbitrary shell on
`source`. Therefore the trust boundary moves to **read time**: add a safe `export` verb
and demote raw `path` sourcing **first**, then delete the write side.

"Stop parsing" means stop **managing entries** (write side: `set`/`unset`/quoting/comments).
It does **not** mean stop `dotenv.parse`-for-injection or LHS-only key-name scanning —
both are retained (injection safety + names-only discoverability).

---

## Phase 0 — Shared security primitives (do first)

Extract the lock / perms / atomic-write / path-traversal / dangerous-key primitives into
one shared module so `secret`, `env`, and the `vault` shim do not fork three divergent
copies of security-critical code during the deprecation window.

- **New** `src/commands/secrets-common.ts` (or `src/core/secret-store.ts`): house
  `withFileLock` (from `withVaultLock`/`withSecretLock`), `ensureParentDir`, the atomic
  writers, and the path-traversal guard. `vault.ts`/`env.ts` and `secret.ts` consume it.
- This is internal-only; no CLI/behavior change. Keeps Phase 2+ from duplicating locks.

## Phase 1 — Read-path hardening (ship before any deletion)

1. **`src/commands/vault.ts`** — promote `buildShellExportScript` (vault.ts:213) from
   "retained for tests" to the backing implementation of a new `export` verb. No logic
   change; it already emits `export KEY='…'` with `'\''` single-quote escaping and the
   `/^[A-Za-z_][A-Za-z0-9_]*$/` key-shape guard.
2. **`src/cli.ts`** — add `akm vault export <ref>` (temporary, becomes `akm env export`
   in Phase 2) that runs `loadEnv` → `buildShellExportScript` and prints to stdout.
3. **Demote `path`:** update `vaultPathCommand` (cli.ts:2182) help text to the Docker
   `_FILE` / read-it-yourself convention and emit a one-line **stderr** warning that
   sourcing the raw file executes arbitrary shell. Never document `source "$(… path)"`
   again — replace with `eval "$(akm env export env:prod)"`.
4. **Docs:** change every `source "$(akm vault path …)"` occurrence (docs/cli.md,
   docs/concepts.md, examples) to the `eval "$(akm env export …)"` idiom.

> After Phase 1, deleting `quoteValue`/`setKey` is safe: nothing sources raw bytes.

## Phase 2 — New `env` asset type

5. **Rename** `src/commands/vault.ts` → `src/commands/env.ts`.
   - **Delete:** `setKey` (244-297), `unsetKey` (300-339), `quoteValue` (374-383),
     `validateKeyName` (385-389), `scanComments` (105-114).
   - **Keep (+rename where noted):** `loadEnv`, `injectIntoEnv`, `buildShellExportScript`,
     `createVault`→`createEnv`, `withVaultLock`→`withEnvLock` (still needed for `create`
     + migration writes), `ensureParentDir`, `scanKeys`, `listKeys`, `listEntries`.
6. **`src/commands/lint/vault-key-rules.ts`** → rename to `env-key-rules.ts`. Keep
   `DANGEROUS_VAULT_KEYS` (34), `DANGEROUS_VAULT_KEY_PATTERNS` (97), `isDangerousVaultKey`
   (111), `checkVaultForDangerousKeys` (132); re-export under env-neutral names with thin
   back-compat aliases. **Update all three verified importers in the same commit:**
   `src/cli.ts:2480` (secret-run hijack-var guard), `src/commands/add-cli.ts:190`
   (`akm add` supply-chain gate), `src/commands/lint/index.ts:15`.
   ⚠️ Deleting this module breaks the **shipped** `secret run` + `akm add` — rename only.
7. **`src/core/asset-spec.ts`** — add an `env` entry (line 94 has `vault`): copy
   `toCanonicalName`/`toAssetPath` **verbatim** (`.env` → `default`, `<name>.env` →
   `<name>`), `stashDir: "env"`, `rendererName: "env-file"`. Keep the `vault` entry in
   0.8.0 but flip its action hints to point at `env`. Remove `vault` entry in 0.9.0.
8. **`src/core/common.ts`** — append `"env"` to the `ASSET_TYPES` union (line 14, after
   `secret`). Keep `vault` in the union through 0.8.0 (drop in 0.9.0).
9. **`src/core/asset-registry.ts`** — add `env: "env-file"` renderer mapping (line ~30)
   and an `env` action builder (line ~46) without `set`/`unset` hints. Keep `vault`
   mapping in 0.8.0.
10. **`src/cli.ts`** — register the `env` verb with subcommands
    `list | show | path | export | run | create`:
    - Add `parseEnvRef` / `resolveEnvironmentPath` accepting `env:` (canonical),
      `environment:` (alias), `vault:` (deprecated alias → warns to stderr); resolver
      prefers `env/` and **falls back to `vaults/`** when `env/` is absent (handles
      upgraded-binary-not-yet-migrated). Keep the path-traversal "escapes the directory"
      guard.
    - `env run <ref> -- <cmd>`: whole-file injection only (drop the single-key `ref/KEY`
      form and `splitVaultRunTarget`, cli.ts:2005-2029, plus the `if (key)` branch at
      ~2243). Before spawn, iterate **all** injected keys through `isDangerousEnvKey`:
      **WARN** for first-party/local stashes, **BLOCK** for third-party-sourced stashes.
    - `ENV_SUBCOMMAND_SET = new Set(["list","show","path","export","run","create"])`
      (replaces `VAULT_SUBCOMMAND_SET`, referenced at cli.ts:2295).
11. **Output layer (value-never-to-stdout enforced structurally):**
    - `src/output/renderers.ts` — clone `vaultEnvRenderer` → `env-file` renderer (keys +
      comments only; **omit `content`/`template`/`prompt`**). Rename `applyVaultMetadata`
      → `applyEnvMetadata` (names-only `searchHints`/`hit.keys`).
    - `src/output/shapes/vault-list.ts` → `env-list.ts` (strip `path`).
    - `src/output/shapes/passthrough.ts` — drop `vault-set`/`vault-unset`; add `env-create`.
    - `src/output/text/vault.ts` → `env.ts` — drop `formatVaultSet*`/`formatVaultUnset*`;
      keep list/create formatters.
12. **`src/indexer/metadata.ts`** (vault dir rules ~627-632, ~1038-1041) and
    **`matchers.ts`** (~76-79) — point the dir rules + `.sensitive` skip logic at `env/`
    and the `env` type. Leave `secret` untouched. Once `env/` exists post-migration, the
    0.8.0 `vault` spec must **stop** contributing names so key-names aren't double-indexed.
13. **`src/integrations/agent/prompts.ts`** (~68) — rewrite the description: `env` =
    whole `.env` file (key names surfaced for discovery, values never; inject via
    `akm env run env:<name> -- <cmd>` / load via `eval "$(akm env export …)"`), sharply
    contrasted with `secret` = one opaque value → one `$VAR`. Update `spawn.ts:37` comment.
14. **`src/setup/setup.ts`** — scaffold the `env/` directory (alongside `vaults/` in 0.8.0).

## Phase 3 — `vault` deprecation shim (0.8.0)

15. **`src/cli.ts`** — rewrite the `vault` verb as **warn-and-delegate**:
    - Print one **stderr** line (never stdout — preserves machine output + the
      value-never-to-stdout invariant): `akm vault is deprecated and will be removed in
      0.9.0; use \`akm env\`. For single-value injection use \`akm secret\`.`
    - Delegate `list/show/path/export/run/create` to the `env` handlers through the same
      parser-mediated path (no raw-path fast path).
    - **HARD-ERROR** (non-zero exit, no write) on `vault set` / `vault unset` →
      signpost `akm secret set` or "hand-edit the file + `eval \"$(akm env export …)\"`".
    - **HARD-ERROR** on `vault run <ref>/KEY` (single-key form) → signpost
      `akm secret run secret:<KEY> <KEY> -- …`.
16. Re-point the `akm:akm-vault` skill at the `env` handler with the deprecation note.

## Phase 4 — Migration (copy, never move)

17. **`scripts/migrate-storage.ts`** — add `migrateVaultsToEnv(ctx)` as a step inside the
    existing `v08To09Migration.run` (line 848-861), sibling to `migrateGraphFileToDb`:
    - `copyDirRecursive(vaults/ → env/)` (helper at line 126) copying `.env`/`.sensitive`/
      `.lock` as **opaque bytes** — never read/reserialize contents.
    - **New post-copy pass:** `chmod 0600` each copied file + `0700` the target dir, then
      **verify** mode. ⚠️ `copyAndVerify` (line 119) checks **size only** and does not
      preserve mode — without this, migrated secret material can land at umask default.
    - Verify `env`-file-count ≥ `vault`-file-count before marking success.
    - **Idempotency guard lives inside the step** (not `isNeeded`): `v08To09Migration.isNeeded`
      already returns `true` unconditionally (line 851, by design, to list the graph step).
      The step itself runs only when `vaults/` exists AND `vaults/.migrated` is absent;
      on success it writes `vaults/.migrated`.
    - **Never delete `vaults/`** — leave it as a frozen copy; defer removal to 0.9.0 behind
      explicit per-path user approval (global no-destructive-data rule).
    - Print a reminder to run `akm index` afterward.
18. **Do NOT crawl/rewrite `vault:` refs embedded in user assets** (never-mutate-user-content).
    The resolver's prefix fallback (step 10) handles old refs through 0.9.0.

## Phase 5 — Audit events

19. **`env_access`** emitted on `env run` (keys only, never values), mirroring `vault_access`.
    **Recommended (security reviewer):** emit a **single** event with a `deprecatedAlias:
    "vault_access"` metadata field rather than dual-emitting two physical events — higher
    audit fidelity, avoids SIEM dedup bugs that could mask a real access. *(This is the one
    remaining owner micro-decision; plan defaults to single-event-with-alias.)*

## Phase 6 — Tests

20. **Sentinel-value no-leak test** (hard ship-gate, mirror `secret-indexing.test.ts`):
    seed a known VALUE in an env file, assert it never appears in `show` / `list` /
    `search --json` output.
21. **Retarget** `tests/vault-traversal.test.ts` at `resolveEnvironmentPath`.
22. Add `env` path/run/export tests (whole-file injection; `export` → `eval` round-trip;
    `run` dangerous-key WARN/BLOCK).
23. Extend `tests/vault-dangerous-key-lint.test.ts` to the `env` type; keep `secret run`
    + `akm add` guard tests green after the `env-key-rules.ts` rename.
24. Add shim tests: `akm vault set`/`unset` hard-error + exit code; `vault:` ref warns to
    stderr and resolves; raw-`path` deprecation warning present.

## Phase 7 — Docs

25. **`docs/cli.md`** — rewrite the vault section as `env` (keep the secret section);
    document `eval "$(akm env export …)"` and `akm env run`. Add the deprecation banner.
26. **`docs/concepts.md`** (line ~96 table row) + **`docs/stash-makers.md`** — update.
27. **CREATE `docs/migration/v0.8-to-v0.9.md`** for the vault→env migration.
    ⚠️ Do **NOT** edit the shipped `docs/migration/v0.7-to-v0.8.md` or `v07To08Migration`.

---

## Sequencing summary (why this order)

```
Phase 0  shared primitives        ── no behavior change, prevents forked security code
Phase 1  read-path hardening      ── MUST precede any write-side deletion (shell-injection gate)
Phase 2  new env type             ── delete write side (now safe), add env verb + renderer
Phase 3  vault shim               ── warn/delegate, hard-error set/unset + run/KEY
Phase 4  copy migration           ── opaque copy + chmod-verify + .migrated marker, never move
Phase 5  audit events             ── env_access (single event + deprecatedAlias)
Phase 6  tests                    ── sentinel no-leak gate, retargeted traversal, shim tests
Phase 7  docs                     ── env idioms, new migration doc (don't touch v0.7-to-v0.8)
```

## What 0.9.0 removes (follow-up release)

- The entire `vault` verb + `VAULT_SUBCOMMAND_SET`, the `vault:` ref alias (→ unknown-type
  error naming `env:`), the `vault` asset-spec entry, `vault` from `ASSET_TYPES`, the
  `vault_access` alias event, and the back-compat name aliases in `env-key-rules.ts`.
- Delete the frozen `vaults/` directory **only** after explicit per-path user approval.

## Verified anchors (checked against the tree, not assumed)

| Claim | Location | Verified |
|---|---|---|
| `vault path` prints raw absPath | cli.ts:2182-2199 | ✓ |
| `buildShellExportScript` unwired ("retained for tests") | vault.ts:213 | ✓ |
| dangerous-key module importers | cli.ts:2480, add-cli.ts:190, lint/index.ts:15 | ✓ |
| `v08To09Migration` slot, `isNeeded` returns true | migrate-storage.ts:848-861 | ✓ |
| `MIGRATIONS` registry | migrate-storage.ts:865 | ✓ |
| `copyAndVerify` checks size only (no mode) | migrate-storage.ts:119 | ✓ |
| `copyDirRecursive` | migrate-storage.ts:126 | ✓ |
| `ASSET_TYPES` union | common.ts:14 (vault@22, secret@23) | ✓ |
| asset-spec `vault`/`secret` entries | asset-spec.ts:94 / :123 | ✓ |
| `VAULT_SUBCOMMAND_SET` use | cli.ts:2295 | ✓ |

## Open micro-decisions (defaults chosen, override if desired)

1. **Audit event:** single `env_access` + `deprecatedAlias` metadata *(default)* vs.
   dual-emit `env_access` + `vault_access` through 0.9.0.
2. **`env run` dangerous-key on first-party stash:** **WARN** *(default)* vs. BLOCK.
   (Third-party-sourced stashes BLOCK either way.)
