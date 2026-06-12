# Evaluation: adopting `ink` (React-for-CLIs) for akm's TUI surfaces

**Status:** evaluation / recommendation
**Date:** 2026-06-08
**Trigger:** #513 (`akm config edit` — BIOS-style menu + forms, beyond clack's linear model)
**Question:** Adopt `ink` **now** instead of building #513 on `@clack/prompts` and rewriting later?

---

## TL;DR recommendation

**Option (b): `@clack/prompts` now, revisit `ink` only when a *second* rich-TUI surface appears.**

The decisive factor is **not** a technical blocker — empirically, **ink renders correctly inside akm's `bun build --compile` single binary** (verified, see below), so the neo-blessed-class packaging risk does **not** apply to ink. The decisive factor is **strategic weight vs. demand**: akm is agent-first (`--format json` is the default consumer), a TUI is a human-only convenience, and #513 is the **only** foreseeable rich-TUI surface. Paying ink's cost (React mental model, +24 transitive deps incl. react/react-reconciler/scheduler/yoga, an unmaintained optional-dep compile gotcha to babysit) to serve a single human-convenience screen is misaligned. The throwaway cost of doing #513 in clack first is **small** (a few hundred LOC), and that's cheap insurance against committing the whole project to React-in-the-terminal for one screen.

---

## 1. Empirical compatibility — the decisive tests

Scratch project: `/tmp/ink-test`. Stack: `ink@7.0.5`, `react@19.2.7`, `ink-select-input@6.2.0`, `ink-text-input@6.0.0`, `yoga-layout@3.2.1`. Runtimes: Bun 1.3.14, Node 24.13.0.

### yoga packaging (the make-or-break detail)

ink's flexbox engine is `yoga-layout` (Meta's Yoga, compiled from C++). **In 3.x it ships the WASM base64-inlined into an ESM module** (`yoga-layout/dist/binaries/yoga-wasm-base64-esm.js`, 119 KB), instantiated synchronously from a JS string at import. There are **zero external `.wasm` files and zero `.node` native bindings** in the whole dependency tree:

```
$ find node_modules -name "*.wasm" | wc -l
0
$ find node_modules -iname "*.node" | wc -l
0
```

This is *why* ink behaves differently from the neo-blessed-class risk and from ink's own historical Bun bug (see §2): there is no external binary asset for `bun --compile` to lose.

### Test 1 — Bun, non-interactive render (no TTY): PASS

`bun run render-test.tsx` (renders ink to stdout via `ink.render`) drew the bordered flexbox box correctly:

```
╭──────────────────────────────────────╮
│ AKM Config                           │
│ Provider: lm-studio                  │
│ Model: qwen3-35b-a3b                 │
╰──────────────────────────────────────╯
[RENDER-TEST] ink+react+yoga rendered successfully
```

### Test 2 — Node native ESM (akm's real Node path, unbundled): PASS

akm ships to Node via `tsc` (per `package.json` `build`), **not** a bundle. Run unbundled under Node's native ESM loader, ink + react + yoga rendered cleanly (`node node-direct.mjs` → box drawn, exit 0). (An esbuild-*bundled* variant failed on yoga's top-level-await under CJS interop — but that is an esbuild bundling artifact, not akm's path, and not how akm ships to Node.)

### Test 3 — `bun build --compile` single binary (THE KEY TEST): PASS (with one required fix)

This is the exact command class akm's release uses (`.github/workflows/release.yml:145` → `bun build ./src/cli.ts --compile`).

- **First attempt FAILED at build time:**
  ```
  error: Could not resolve: "react-devtools-core"
      at node_modules/ink/build/devtools.js:7:22
  ```
  ink statically `import`s `react-devtools-core` (an **optional peer dependency**, only used at runtime when `DEV=true`). Bun's `--compile` eagerly resolves the static import and fails even though the code is dead in production. This is a **known, currently-open ink issue** ([ink#886](https://github.com/vadimdemedes/ink/issues/886)): a v6.8.0 refactor changed an inlinable `process.env['DEV'] === 'true'` check into a function call that bundlers can no longer tree-shake.

- **FIX: `bun add react-devtools-core` so the import resolves and bundles in.** Then:
  ```
  $ bun build ./render-test.tsx --compile --outfile inkapp2   # 543 modules, exit 0
  $ ./inkapp2
  ╭──────────────────────────────────────╮
  │ AKM Config                           │
  │ Provider: lm-studio                  │
  ...
  [RENDER-TEST] ink+react+yoga rendered successfully           # exit 0
  ```
  **The 92 MB compiled binary loads react + react-reconciler + the base64 yoga WASM and renders correctly from inside `$bunfs`.** (`--external react-devtools-core` also builds but then crashes at runtime — `Cannot find package 'react-devtools-core' from '/$bunfs/root'` — because ink still eagerly imports it at module load. So the correct fix is *install it*, not externalize it.)

### Test 4 — interactive select + text-input in the compiled binary, via a real PTY: PASS

Compiled the interactive app (`ink-select-input` + `ink-text-input`) and drove it through a PTY (`script -qec ./inkapp-interactive`). Sending a down-arrow moved the selection cursor live:

```
│ Sections      LLM                    │
│   LLM         Provider: lm-studio    │
│ ❯ Embeddings                         │
│   Stashes                            │
```

Raw-mode keyboard input, live re-render, select + text input **all work inside the `bun --compile` artifact**.

### Cost measured empirically

| Metric | Value |
|---|---|
| Compiled binary, bare (no ink) | **91 MB** |
| Compiled binary, full ink stack | **92 MB** → **~1 MB delta** (Bun runtime dominates) |
| `node_modules` install size (ink stack) | ~15 MB of the deltas (49 MB → 64 MB total scratch) |
| New transitive packages | **~24**: react, react-reconciler, scheduler, yoga-layout, react-devtools-core(+ws), chalk, ansi-escapes/-regex/-styles, string-width, wrap-ansi, slice-ansi, cli-boxes/-cursor/-truncate, patch-console, auto-bind, signal-exit, etc. |

**Binary-size impact is negligible (~1 MB).** The real cost is dependency surface and mental model, not bytes.

### Empirical verdict

**ink WORKS in the bun-compiled binary** — build, load, yoga WASM instantiation, render, and interactive raw-TTY input all succeed. The **one** required step is `bun add react-devtools-core` so the unconditional static import resolves under `--compile` (ink#886, open). This is a real but trivial, well-understood gotcha — not a blocker. The neo-blessed make-or-break risk (native/external binary breaking under `--compile`) **does not apply to ink** because yoga ships as inlined base64 WASM with no external asset.

---

## 2. Maturity / ecosystem

- **ink** is actively maintained by Vadim Demedes; current major **v7** (our test resolved `ink@7.0.5`), React 19 compatible, ~28k+ GitHub stars. It's the de-facto standard for rich React-style terminal UIs. ([vadimdemedes/ink](https://github.com/vadimdemedes/ink))
- **Real-world users:** Gatsby, Prisma, Shopify CLI, GitHub Copilot CLI, Jest/Parcel-adjacent tooling — and the current generation of agent CLIs (Claude Code, Gemini CLI) are ink-based. This is a healthy, widely-trusted ecosystem (contrast neo-blessed: v0.2.0, ~7 years stale, a graveyard of forks-of-forks). ([madewithreactjs/ink](https://madewithreactjs.com/ink), [logrocket](https://blog.logrocket.com/using-ink-ui-react-build-interactive-custom-clis/))
- **Components for a config editor exist and are maintained:** `ink-select-input`, `ink-text-input`, plus the first-party **Ink UI** component kit (text input, select, alerts, lists) and `ink-testing-library`. Focus management is built into ink (`useFocus`/`useFocusManager`). ([vadimdemedes/ink-ui](https://github.com/vadimdemedes/ink-ui), [ink-testing-library](https://github.com/vadimdemedes/ink-testing-library))
- **Known Bun + ink issues (researched, both understood):**
  1. [Bun #13552](https://github.com/oven-sh/bun/issues/13552) — "`bun build --compile` Cannot find module ./yoga.wasm" (Bun 1.1.26, ink 5). **Closed.** This was the *external* `yoga.wasm` era; **yoga 3.x base64-inlines the WASM**, which is exactly why my test on the current stack does not reproduce it.
  2. [ink #886](https://github.com/vadimdemedes/ink/issues/886) — react-devtools-core not tree-shakeable since v6.8.0; **open.** Workaround proven above (install the dep). This is the only live papercut and it's permanently solvable by pinning the dep.

**Maturity verdict:** ink is mature, actively maintained, and ecosystem-rich — there is no maturity argument against it. The only operational caveat is the open `react-devtools-core` compile papercut, which has a one-line fix.

---

## 3. Does akm actually outgrow clack? (concrete surfaces)

akm is **agent-first**: `--format json` is the default output and the primary consumer is AI agents. A TUI serves humans only. Surveying the command surface (`src/commands/*`) and open issues for *latent rich-TUI* needs:

| Candidate surface | Exists / issue | Needs ink-class (free-nav widget tree) or clack-class (linear prompts)? |
|---|---|---|
| `akm config edit` (#513) | open, the trigger | Wants free-nav (left-nav + forms). **clack-class is sufficient**: a section `select` → per-field prompts loop, save/quit. Not as slick as BIOS, but fully functional. |
| `akm setup` wizard (`src/setup/`, 2884 LOC) | shipped | **clack-class** — it's inherently a linear wizard; already on clack and works in all 3 runtimes. |
| Confirm / sources add / stash add | shipped | **clack-class**, already done. |
| Tasks enable/disable (#512) | open | **clack-class** (a multiselect/toggle list). |
| Proposal review, severity rendering (#557) | open | Output formatting, **not interactive** — no TUI lib needed. |
| Workflow check-in / spawned monitor (#559) | open | A *monitor*, but spec is "spawned, no daemon" — log/stream output, **not a widget dashboard**. |
| improve/health/curate browsers | code exists | Currently non-interactive or `node:readline` (`improve/consolidate.ts`). No issue asks for a live dashboard. |

**Verdict: #513 is the ONLY foreseeable rich-TUI surface, and even it is doable in clack.** There is no improve/health dashboard, no interactive search browser, no workflow-run TUI on the roadmap that would demand ink. The "akm will outgrow clack" premise is **not supported by the current codebase or issue backlog.** A single screen that is *nicer* in ink is not the same as *outgrowing* clack.

---

## 4. Cost comparison

### ink NOW
- **Pros:** one toolkit for all future TUIs; #513 gets the true BIOS-style free-nav UX; mature/maintained; component ecosystem ready; **proven to work in the compiled binary**.
- **Cons:** +24 transitive deps (react + react-reconciler + scheduler + yoga + devtools/ws + ~15 ansi/string helpers) on a project whose entire current dep list is 8 packages; a React mental model (hooks/reconciler/effects) imposed for terminal forms; a permanent `react-devtools-core` compile pin to maintain (ink#886, open); ongoing React-major-version coupling. All of this **to serve one human-only convenience screen** in an agent-first tool.

### clack NOW + ink LATER — quantifying the throwaway
- `akm config edit` on clack = a **new `edit` subcommand in `src/commands/config-cli.ts`**, schema-driven from `config-schema.ts` (Zod, already the single source of truth), reusing `loadConfig`/`saveConfig`/`backupExistingConfig`/the config-walker. Interaction = `select` the section → loop per-field `text`/`select`/`confirm` prompts → confirm save. **Estimated ~200-400 LOC**, zero new deps, same paradigm as `setup`, already proven in all 3 runtimes incl. the compiled binary.
- If ink is adopted later, that surface is a **from-scratch rewrite** (linear-prompts → React component tree) — not incremental. But it's a few hundred LOC of throwaway, **not** thousands. That is a cheap option to preserve.
- Crucially: choosing clack now is **reversible and informative** — if a *second* genuine rich-TUI surface materializes, that's the signal to adopt ink and rewrite #513 onto it, now amortizing ink across two surfaces instead of one.

**Net:** the throwaway from clack→ink for #513 is small (hundreds of LOC) and bounded. The cost of adopting ink now is structural and permanent (React + 24 deps + a compile pin) and is **not** amortized — it's paid in full for a single screen.

---

## 5. Final recommendation

**(b) Ship `akm config edit` on `@clack/prompts` now; revisit `ink` only when a second rich-TUI surface concretely appears** (e.g. a live improve/health dashboard or a workflow-run monitor that genuinely needs a persistent widget tree).

**Single decisive factor:** It is *not* technical risk — ink is empirically proven to work in akm's `bun --compile` binary. It is **strategic alignment**: akm is agent-first (JSON is the default surface), #513 is the *only* foreseeable human-only rich-TUI need, and it's fully achievable in clack with zero new deps. Adopting React-in-the-terminal plus 24 transitive deps to serve one convenience screen is disproportionate. Keep ink as a *validated, low-risk option* (this doc is the de-risking) and exercise it the moment a second surface makes it pay for itself.

> If product direction changes and a human-facing TUI becomes a first-class pillar (multiple dashboards/browsers), flip to ink without hesitation — the compiled-binary blocker is disproven; just `bun add react-devtools-core` and pin it.

---

### Reproduction (scratch, `/tmp/ink-test`)
```
bun add ink react ink-select-input ink-text-input react-devtools-core
bun run render-test.tsx                                   # Test 1 (Bun render)
node node-direct.mjs                                      # Test 2 (Node native ESM)
bun build ./render-test.tsx --compile --outfile inkapp2   # Test 3 (compile) — needs react-devtools-core installed
./inkapp2                                                 # Test 3 run — renders, exit 0
bun build ./app.tsx --compile --outfile inkapp-interactive
script -qec ./inkapp-interactive /dev/null               # Test 4 (interactive PTY)
```
