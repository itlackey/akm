# Roadmap

This page outlines the high-level focus for the next two releases.

It is intentionally directional rather than exhaustive. Detailed command,
schema, and migration behavior still lives in the release notes, migration
guides, and the v1 architecture spec.

## 0.8 Foundation

Release `0.8.0` already established much of the product shape that `0.9` and
`1.0` build on.

- The CLI and config surface were substantially redesigned.
- `akm improve` became the main self-improvement and maintenance entry point.
- Task assets, proposal workflows, health reporting, and agent command-building
  all landed as first-class capabilities.
- Storage, indexing, graph extraction, and migration paths were tightened to
  support the v1 contract freeze.

That means the next two releases are less about inventing a new direction and
more about hardening, simplifying, and freezing what `0.8.0` put in place.

## 0.9

Release `0.9` is the architecture-consolidation release ahead of the `1.0`
contract freeze. It replaces the flat asset-type registry with a
**bundle / adapter** model and settles the durable contracts `1.0` will freeze.

- **One canonical ref grammar.** Refs are `[bundle//]conceptId` — a
  subdir-qualified concept id such as `skills/code-review` or `memories/vpn-note`
  — replacing the pre-`0.9` `type:name` spelling. Durable state stores the
  fully-qualified form; the short bundle-omitted form is input sugar. This is a
  deliberate, one-time break, taken pre-`1.0` while it is still cheap.
- **Format-neutral bundles.** Installed sources are bundles, each recognized by
  a built-in adapter (Agent Skills, Claude/OpenCode commands and agents,
  knowledge, YAML workflows, tasks, env/secret files, scripts, OKF and LLM-wiki
  knowledge bases) instead of a closed asset-type list.
- **Storage consolidation.** The durable databases collapse from four to three
  (`state.db` / `index.db` / a separate `logs.db`); config migrates from the
  flat `stashDir` / `sources` / `installed` keys to `bundles` / `defaultBundle`.
  The one-time cutover is journaled and crash-resumable via `akm migrate apply`,
  with a verified backup taken first.
- **Debt paydown.** The improve / proposal / workflow internals are decomposed
  onto one file-change transaction model and an ambient run context, the
  deprecated `0.8` CLI aliases are removed, and the `vault` asset type is
  retired in favor of `env` / `secret`.

In short: `0.9` reduces ambiguity, pays down pre-`1.0` debt, and arrives at a
small, durable core ready for the `1.0` freeze.

### The 0.9.x series

`0.9.x` is a series of refactoring and clean-up releases. The intent is to
have **all technical debt paid off and all planned breaking changes handled
before the 0.10.x series begins**. To get there quickly, 0.9.x patch releases
may include breaking changes (see [STABILITY.md](../../STABILITY.md)); every
break ships with a CHANGELOG migration note.

## 0.10

The `0.10.x` series is focused on **bug fixes and tuning** on top of the
debt-free 0.9 core — no new architecture. With the clean-up done, 0.10.x
attempts to return to the normal semver discipline: breaking changes only in
major and minor releases, never in patches.

## 1.0

Release `1.0` is focused on freezing the public contract and shipping the first
stable ecosystem layer around that core.

- Freeze the supported source model, the `[bundle//]conceptId` ref format,
  search behavior, write-target rules, and other public contracts documented in
  the v1 spec.
- Carry the `0.8` agent and improvement workflow forward as a stable,
  documented product surface rather than a collection of pre-release features.
- Ship an official akm SDK for building integrations against the stable v1
  contract instead of reverse-engineering CLI behavior.
- Ship in-process akm plugins for Claude Code and OpenCode, built on that SDK,
  so those tools can integrate more deeply without changing the CLI-first core
  model that akm itself relies on.
- Keep the CLI as the canonical foundation so the SDK and plugin story extends
  the existing system rather than forking it into separate integration models.

In short: `1.0` is where akm stops being only a strong CLI and becomes a stable
platform for both direct use and deeper tool integration.

## Scope Notes

- The CLI remains the foundation in both releases.
- `0.9` prioritizes hardening over expansion.
- `1.0` adds the SDK and in-process plugin story on top of a frozen core, not
  instead of it.
- The roadmap assumes the `0.8.0` redesign is the baseline; later releases are
  about stabilizing and extending that baseline, not replacing it.
- Specific features may move between releases as implementation and testing
  shake out, but the themes above are the intended direction.
