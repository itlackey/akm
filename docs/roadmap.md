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

Release `0.9` is focused on stabilization ahead of the `1.0` contract freeze.

- Finish the remaining pre-`1.0` cleanup from the `0.8` transition: remove
  deprecated behavior, close migration gaps, and simplify compatibility paths.
- Lock down the `0.8` command, config, search, and write-path redesign so the
  surviving public surface is consistent and ready to freeze.
- Harden the operational parts of the system that now carry more weight after
  `0.8`: indexing, proposal handling, graph refresh, task execution, and
  upgrade flows.
- Improve operator confidence with stronger validation, migration docs, and
  release-quality testing around the new `0.8` storage and config model.
- Keep the core product CLI-first and shell-friendly while clarifying which
  integration points are part of the stable contract versus still evolving.

In short: `0.9` is about reducing ambiguity, paying down pre-`1.0` debt, and
arriving at a small, durable core built on the capabilities that already
shipped in `0.8.0`.

## 1.0

Release `1.0` is focused on freezing the public contract and shipping the first
stable ecosystem layer around that core.

- Freeze the supported source model, ref format, search behavior, write-target
  rules, and other public contracts documented in the v1 spec.
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
