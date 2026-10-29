# Fixture: `generic-files` bundle (SPECIFICATION goldens)

A root of arbitrary files a user deliberately mounted with the `generic-files`
adapter. Types are `document` / `script` / `file`. This adapter is
**explicit-config only** — it is never auto-probed, and its
`looksLikeRoot` must never fire.

- **Adapter:** `src/core/adapter/adapters/generic-files-adapter.ts`
- **Goldens:** `tests/fixtures/format-family-goldens/generic-files/{recognition,lint,renderer}.json`

Files: `notes.md` (→ document), `build.sh` (→ script, `.sh` ∈ SCRIPT_EXTENSIONS),
`data.csv` (→ file).

**Flags:** the exact document/script/file classification predicate, the
placement convention, and the missing `document`/`file` presentation entries are
open questions. Best-reasoned defaults are recorded in the goldens.
