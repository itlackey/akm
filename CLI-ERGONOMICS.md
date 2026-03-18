# CLI Ergonomics Issues

Audit date: 2026-03-18

---

## HIGH — Actively Confusing

<!-- 

VETOED - keep for explicit usage

### 1. Redundant top-level commands

`akm list`, `akm remove`, `akm update` are identical to `akm kit list`, `akm kit remove`, `akm kit update`. Both routes exist, share the same implementation, and are equally discoverable. Users find two paths to the same thing with no guidance on which is canonical.

**Files:** `src/cli.ts` (list ~597, remove ~607, update ~620, kit subcommand ~635-658)

**Recommendation:** Make `akm kit list/remove/update` canonical. Top-level shortcuts should either be removed or print a deprecation notice pointing to the `kit` subcommand. -->

### 2. Ref format inconsistency across search → show → add → clone

Users must understand 4+ ref formats to navigate the core workflow:

| Command | Accepts | Example |
|---------|---------|---------|
| `search` output | `ref` (local) or `id` (registry) | `skill:deploy`, `npm:@scope/pkg` |
| `show` | `type:name`, `viking://path`, `npm:@scope/pkg//type:name` | `akm show skill:deploy` |
| `add` | `github:owner/repo`, `npm:pkg`, local path (becomes stash add) | `akm add github:org/repo` |
| `clone` | `type:name` or `npm:@scope/pkg//type:name` | `akm clone skill:deploy` |

No help text explains the grammar. A user going from search result to `show` to `clone` must translate between formats manually.

**Files:** `src/stash-ref.ts`, `src/registry-resolve.ts`, `src/cli.ts`, `src/origin-resolve.ts`

**Recommendation:** Normalize to a universal ref format. Every search hit should include an `action` field with the exact command to use, and a `ref` field that works across all commands.

---

## MEDIUM — Friction

### 3. Two overlapping search commands

`akm search --source registry` and `akm registry search` do the same thing. Users who discover one may not know the other exists, leading to inconsistent scripts and documentation.

**Recommendation:** Keep both for now.

### 4. `--for-agent` is half-implemented

Only works on `search` and `show` but appears as a global flag. Silently overrides `--detail` with no warning. Users trying `akm list --for-agent` or `akm manifest --for-agent` get no agent-optimized output.

**Recommendation:** Remove --for-agent

### 5. Detail levels are opaque

`summary` vs `normal` vs `full` — the differences aren't documented in help text. `summary` means metadata-only (~200 tokens), `normal` includes most fields but not raw content, `full` includes everything. Users must test to learn.

**Recommendation:** Add one-line descriptions in `--detail` help: `brief (names only) | normal (default, metadata + description) | full (everything, scoring etc)`. Remove summary and ensure normal is compact but useful as the summary.

### 6. Flag names diverge between similar commands

`akm registry add <url>` vs `akm stash add <target>` — different positional arg names for the same concept. Both also have `--provider` but referring to different provider systems.

**Recommendation:** Use `<target>` consistently for all add/remove commands.

### 7. `add` vs `clone` is unclear

`add` installs a kit (makes it searchable). `clone` copies a specific asset to your working stash (makes it editable). The names don't convey this distinction.

**Recommendation:** Skip, these are standard terms.

### 8. No search-to-action shortcut

The common workflow is: search → copy ref from output → show → copy ref → clone/use. This requires 3 manual copy-paste steps.

**Recommendation:** Search results already include `action` fields. Consider `akm search --exec N` to execute the Nth result's action directly.

### 9. Knowledge show syntax is positional and non-discoverable

`akm show knowledge:guide toc`, `akm show knowledge:guide section "Auth"`, `akm show knowledge:guide lines 10 50` — positional subcommands parsed via `normalizeShowArgv`. Users won't discover these without reading hints.

**Files:** `src/cli.ts` lines 1249-1323

**Recommendation:** Add `--mode toc|section|lines`, `--heading`, `--start`, `--end` flags and remove positional syntax.

### 10. Config keys not documented in help

`akm config set <key> <value>` doesn't list valid keys. Users must guess or read source.

**Recommendation:** Add valid key list to help text or support `akm config list-keys`.

### 11. `--limit` typed as string

`--limit` is defined as `type: "string"` in citty args, then parsed with `parseInt`. Should be `type: "number"`.

**Files:** `src/cli.ts` lines 551, 932

### 12. `--format jsonl` behavior varies by command

For search, emits one JSON object per hit (streaming). For other commands, emits the full response as a single JSON line. Not documented.

**Recommendation:** Make it consistent (always stream array items).

---

## LOW — Polish

### 13. `--source` default not shown in help

Default is "stash" but the arg description just says `Search source (stash|registry|both)`.

### 14. Tab completion gaps

No completion for asset refs, names, installed kit IDs, or config keys. Only flags and their static values are completed.

**Files:** `src/completions.ts`

### 15. Error hints are brittle

Error hint matching (lines 1225-1241) uses `message.includes("...")` checks. If error text changes, hints break silently.

**Recommendation:** Use error codes or error types instead of string matching.

---

## Recommended Priority Order

1. Normalize ref format (issue #2) — highest user impact
2. Deprecate redundant commands (issue #1) — reduces confusion
3. Merge registry search into search --source (issue #3) — simplifies CLI surface
4. Document detail levels and --for-agent scope (issues #4, #5) — reduces guesswork
5. Fix --limit type, add config key docs (issues #10, #11) — quick wins
