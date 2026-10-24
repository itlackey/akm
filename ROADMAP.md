# Roadmap

This page outlines the high-level direction for the releases ahead.

It is intentionally directional rather than exhaustive. Detailed command,
schema, and migration behavior lives in the release notes, the migration
guides, and [STABILITY.md](STABILITY.md), which classifies today's public
contract by surface and lists the planned changes under "On the horizon".

## 0.9

Release `0.9` consolidated the architecture ahead of the `1.0` contract
freeze. It replaced the flat asset-type registry with a **bundle / adapter**
model and settled the durable contracts `1.0` will freeze.

- **One canonical ref grammar.** Refs are `[bundle//]conceptId` — a
  subdir-qualified concept id such as `skills/code-review` or
  `memories/vpn-note` — replacing the earlier `type:name` spelling. Durable
  state stores the fully-qualified form; the short bundle-omitted form is input
  sugar.
- **Format-neutral bundles.** Installed sources are bundles, each recognized by
  a built-in adapter (Agent Skills, Claude/OpenCode commands and agents,
  knowledge, YAML workflows, tasks, env/secret files, scripts, OKF and LLM-wiki
  knowledge bases) instead of a closed asset-type list.
- **Storage consolidation.** Durable state lives in `state.db`, `index.db` and
  `logs.db`, and config is keyed by `bundles` / `defaultBundle`. `akm migrate
  apply` moves an older installation to the current shape, with a backup first.
- **Debt paydown.** The 0.8-era CLI aliases were removed and the `vault` asset
  type was retired in favor of `env` / `secret`.

### The 0.9.x series

`0.9.x` is a series of refactoring and clean-up releases. The intent is to
have **all technical debt paid off and all planned breaking changes handled
before the 0.10.x series begins**. To get there quickly, 0.9.x patch releases
may include breaking changes (see [STABILITY.md](STABILITY.md)); every
break ships with a CHANGELOG migration note.

Alongside the bug fixes and compatibility improvements, `0.9.x` also focuses
on **tuning the improve processes** — reflect, distill, consolidate, memory
inference, and proactive maintenance — and **settling the
final design of those features** so the `0.10.0` release starts from a
finished improve surface rather than one still being reshaped.

## 0.10

The `0.10.x` series is focused on **bug fixes and tuning** on top of the 0.9
core. The planned structural work is the harness rework, the extraction of the
migration tool, and the decision to stabilize or remove workflows (see "On the
horizon" in [STABILITY.md](STABILITY.md)). With the clean-up done, 0.10.x
returns to normal semver discipline: breaking changes only in major and minor
releases, never in patches.

## 0.X

There may be other minor releases between 0.10.x and 1.0.0. The goal is to minimize the number of minor releases after 0.10.x, and they will only be used for addressing breaking changes that are justifiable before the 1.0.0 release.

## 1.0

Release `1.0` is focused on freezing the public contract and shipping the first
stable ecosystem layer around that core.

- Freeze the supported source model, the `[bundle//]conceptId` ref format,
  search behavior, and write-target rules — the surfaces
  [STABILITY.md](STABILITY.md)'s own 1.0 contract-freeze section
  already names — and settle the surfaces it currently classifies as
  Evolving or Experimental.
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

- The CLI remains the foundation in every release.
- `1.0` adds the SDK and in-process plugin story on top of a frozen core, not
  instead of it.
- Specific features may move between releases as implementation and testing
  shake out, but the themes above are the intended direction.
