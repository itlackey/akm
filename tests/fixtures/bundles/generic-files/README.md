# Fixture: `generic-files` bundle (SPECIFICATION goldens)

A root of arbitrary files a user deliberately mounted with the `generic-files`
adapter. Types are `document` / `script` / `file`. This adapter is
**explicit-config only** — it is never auto-probed (spec §1.2), and its
`looksLikeRoot` must never fire.

- **Adapter built by:** a future Chunk-2 format-adapter work item.
- **Goldens:** `tests/fixtures/format-family-goldens/generic-files/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/design/akm-0.9.0-bundle-adapter-spec.md` §7 (generic-files row),
  §1.2 (never auto-selected).

Files: `notes.md` (→ document), `build.sh` (→ script, `.sh` ∈ SCRIPT_EXTENSIONS),
`data.csv` (→ file).

**Flags:** the exact document/script/file classification predicate, the
placement convention, and the missing `document`/`file` presentation entries are
open questions (see the methodology doc). Best-reasoned defaults are recorded in
the goldens.
