---
title: 'akm 0.6.0: Clean Break to Stash, Quieter CLI, Easier Migration'
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm
description: 'akm 0.6.0 is a stabilization release: one domain noun, one lockfile name, one wire format, plus a handful of quality-of-life improvements on the way to v1.'
tags:
  - ai
  - agents
  - cli
  - release
published: true
date: '2026-04-24T00:00:00Z'
---

akm 0.6.0 is out. This one is deliberately boring: a stabilization release that takes a clean break from pre-v1 terminology so the surface area we carry into v1 is honest. The domain model now has one noun for "a source of content" (stash) and one noun for "a service that helps discover them" (registry). The parallel vocabulary that accreted during earlier experiments — "kit", "source", hand-special-cased provider types — is gone. A handful of additive quality-of-life improvements ship alongside, but the headline story is fewer concepts, not more.

If you are on 0.5.x, read [the v0.5 → v0.6 migration guide](../migration/v0.5-to-v0.6.md) before upgrading. Most projects will work without edits thanks to automatic on-disk migrations; a small number of config fields and CLI flags need explicit updates.

## TL;DR

- **One domain noun**: `kits` / `sources` → `stash` everywhere. Wire format, config, CLI help, and docs all use the same word.
- **Schema v3** for the registry index: `stashes[]` replaces `kits[]`. Pre-0.6.0 indexes are no longer read.
- **`akm.lock`** replaces `stash.lock`; auto-copied on first run, no action needed.
- **`stashInheritance: "merge" | "replace"`** replaces the boolean `disableGlobalStashes`.
- **`primary: true`** on a stash entry replaces the top-level `stashDir` field.
- **`--detail=agent`** is the preferred spelling; `--for-agent` stays as a deprecated alias.
- **`akm enable context-hub` / `akm disable context-hub`** are gone — add context-hub as a regular git stash.
- **Discovery**: registry indexes only packages/repos tagged `akm-stash`. The pre-0.6.0 `akm-kit` / `agentikit` keywords/topics are not honored as fallbacks.

Full details — including before/after code for every item — live in the migration guide.

---

## What "clean break" means

This is a simplification, not a rebrand. Through the pre-v1 releases, akm accumulated three overlapping nouns for the same concept:

- "source" — the config field users saw
- "kit" — the packaging / publishing story
- "stash" — the runtime/storage layer

Three words for one thing made every doc page ambiguous and every new feature pick a side. 0.6.0 collapses the three into **stash** at every layer — config, wire format, CLI text, docs, error messages. "Agent Kit Manager" stays as the project tagline and `akm-cli` stays as the package name, because those are *product* names, not data-model terms. Everything below the product surface is stash.

The registry wire format follows the same logic. Schema v3 drops `kits[]` and parses only `stashes[]`. Pre-v1 is the right time to do this: there is no installed base we need to keep parsing legacy wire formats for, and holding onto `kits[]` just to be polite would trap the v1 contract in historical cruft.

## Breaking changes at a glance

Each bullet below links to its section in the migration guide, which has the exact before/after code or config diff.

- [`stash.lock` → `akm.lock`](../migration/v0.5-to-v0.6.md#1-stashlock--akmlock) — auto-copied on first run.
- [`installed[]` → `stashes[]` + `akm.lock`](../migration/v0.5-to-v0.6.md#2-installed--stashes--akmlock) — config cleanup happens on next write.
- [`stashDir` → `primary: true`](../migration/v0.5-to-v0.6.md#3-stashdir--primary-true) — automatic.
- [`disableGlobalStashes` → `stashInheritance`](../migration/v0.5-to-v0.6.md#1-replace-disableglobalstashes) — **manual**, one-line config edit.
- [`--for-agent` → `--detail=agent`](../migration/v0.5-to-v0.6.md#2-replace---for-agent-with---detailagent) — old flag still works as a deprecated alias for one release cycle.
- [`akm enable/disable context-hub` removed](../migration/v0.5-to-v0.6.md#3-replace-akm-enable-context-hub--akm-disable-context-hub) — add it as a regular git stash.
- [Wire format `kits[]` → `stashes[]`](../migration/v0.5-to-v0.6.md#wire-format-change-kits--stashes) — registry publishers must regenerate.
- [Discovery keyword / topic `akm-kit` → `akm-stash`](../migration/v0.5-to-v0.6.md#publisher--kit-maker-changes) — publishers must re-tag.

If you consume only the public registry and do not maintain your own, the publisher changes do not apply to you.

## What's new (low-key)

A few additive improvements rode along with the cleanup.

- **`akm workflow validate <ref|path>`** — new subcommand for validating a workflow markdown file or ref; lists every error in one pass (without running a full reindex). A workflow debugging tool to surface issues before they bite at run time.
- **Memory frontmatter on `akm remember`** — `--tag` (repeatable), `--expires 30d`, `--source <any-string>`, plus opt-in `--auto` (heuristics) and `--enrich` (LLM) for deriving tags from the body. Zero-flag `akm remember "body"` still writes a flat memory, so existing agent scripts are unchanged. Issue [#169](https://github.com/itlackey/akm/issues/169).

  ```sh
  akm remember "VPN required for staging deploys" \
    --tag ops --tag networking --expires 90d --source "skill:deploy"
  ```

- **Workflow parser accepts intro prose** — you can now put a short advisory paragraph between `# Workflow:` and the first `## Step:` without tripping a validation error. Issue [#158](https://github.com/itlackey/akm/issues/158).
- **Workflow resume reclassifies blocked steps** — `akm workflow resume <id>` now re-opens the currently-blocked step so you can mark it `completed`, `failed`, or `skipped` after resolving the blocker. Issue [#156](https://github.com/itlackey/akm/issues/156).
- **Workflow create works in clean stashes** — `akm workflow create <name>` (and `--from <file>`) no longer false-positive on a path escape when any ancestor of the stash is a symlink. Issue [#157](https://github.com/itlackey/akm/issues/157).
- **Registry search drops empty hit objects** — providers returning partial records no longer surface as `{}` in JSON output; dropped counts appear in `warnings` so the upstream bug stays visible. Issue [#159](https://github.com/itlackey/akm/issues/159).
- **Isolated sandbox recipe** — [`getting-started.md`](../getting-started.md#isolated-sandbox-workflow) now includes the one-terminal recipe for a throwaway `HOME` + `XDG_*` + `AKM_STASH_DIR` sandbox. Handy for agent testing, CI, and issue reproduction. Issue [#160](https://github.com/itlackey/akm/issues/160).

None of these require migration action; they are upgrades-by-default once you install 0.6.0.

## Migration

Install:

```sh
npm install -g akm-cli@0.6.0
# or
bun install -g akm-cli@0.6.0
# or from an existing install
akm upgrade
```

Read:

- [v0.5 → v0.6 migration guide](../migration/v0.5-to-v0.6.md) — every breaking change with before/after code; publisher checklist if you maintain a registry or an npm/GitHub stash.

Verify:

```sh
akm info --format text            # version 0.6.x, no context-hub provider
akm config list                   # stashes[] populated, no installed[]
akm list                          # your sources resolve cleanly
```

If something looks wrong after upgrade, the guide has a [troubleshooting section](../migration/v0.5-to-v0.6.md#troubleshooting) covering the common pitfalls (stale context-hub entries, v2 registry URLs, empty `stashes[]` after a read-only upgrade path).

## What's next

0.6.0 is a punctuation mark, not a destination. The next moves are narrower scope and fewer concepts, in that order. Expect the 0.6.x series to pick up whatever friction falls out of this rename; 0.7 starts shaping the contract we intend to freeze at v1.

Thank you to everyone who stayed on pre-v1 through the terminology churn. The point of doing this now — while the installed base is small enough to move together — is that we only do it once. The v1 surface begins here.

Full changelog at [CHANGELOG.md](https://github.com/itlackey/akm/blob/main/CHANGELOG.md).
