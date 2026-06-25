// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Barrel for the git source provider, split by responsibility:
//   - git-provider.ts — the SourceProvider, repo-URL parsing, cache/mirror sync
//   - git-install.ts  — install/clone helpers (`akm add` / `akm update`)
//   - git-stash.ts     — stash save/commit/push
//
// Re-exported here so every consumer (and every `spyOn(gitProvider, …)` test)
// keeps importing from a single module namespace.

export { classifyCloneFailure, cloneRepo, syncRegistryGitRef } from "./git-install";
export {
  ensureGitMirror,
  GitSourceProvider,
  getCachePaths,
  type ParsedRepoUrl,
  parseGitRepoUrl,
  syncMirroredRepo,
} from "./git-provider";
export {
  isGitBackedStash,
  resolveWritableOverride,
  type SaveGitStashResult,
  saveGitStash,
} from "./git-stash";
