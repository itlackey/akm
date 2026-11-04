// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { register } from "node:module";

// Embedded text imports must be registered before evaluating the workspace graph.
register("./text-import-hook.mjs", import.meta.url);

const {
  writeEnv, removeEnv, setSecret, withSecretLock, resolveEnvPath, resolveSecretPath, resolveEnvWriteTarget, resolveSecretWriteTarget, akmTasksSync, renameBundle, withEnvSecretWrite, sensitiveMarkerPath, deriveCanonicalAssetName,
  getAllEntriesForEmbedding, getMeta,
  akmClone,
  handleApiRequest,
  NO_SUCH_ROUTE,
  classifyProposalError,
  handleWriteRequest,
  matchWriteRoute,
  scrubUrlCredentials,
  classifyWorkspaceError,
  handleWorkspaceAction,
  matchWorkspaceAction,
  AkmError, UsageError,
  loadConfig, resolveBundleWriteTarget, assertAkmAssetWrite, prepareWriteTargetForMutation, withWriteTargetMutation,
  isWithin, writeFileAtomic, assetPathForName, stashDirFor, parseRefInput, withAssetMutationLease, assertWriteLeaseFree,
  indexWrittenAssets, akmLint, closeDatabase, openReadonlyExistingDatabase, getAllEntries, getEntryById,
  getEntryIdByFilePath, getEntryCount, getNeighborsByEntryId, hasStoredEmbedding, resolveSourceEntries,
} = await import("./workspace.js");

export {
  writeEnv, removeEnv, setSecret, withSecretLock, resolveEnvPath, resolveSecretPath, resolveEnvWriteTarget, resolveSecretWriteTarget, akmTasksSync, renameBundle, withEnvSecretWrite, sensitiveMarkerPath, deriveCanonicalAssetName,
  getAllEntriesForEmbedding, getMeta,
  akmClone,
  handleApiRequest,
  NO_SUCH_ROUTE,
  classifyProposalError,
  handleWriteRequest,
  matchWriteRoute,
  scrubUrlCredentials,
  classifyWorkspaceError,
  handleWorkspaceAction,
  matchWorkspaceAction,
  AkmError, UsageError,
  loadConfig, resolveBundleWriteTarget, assertAkmAssetWrite, prepareWriteTargetForMutation, withWriteTargetMutation,
  isWithin, writeFileAtomic, assetPathForName, stashDirFor, parseRefInput, withAssetMutationLease, assertWriteLeaseFree,
  indexWrittenAssets, akmLint, closeDatabase, openReadonlyExistingDatabase, getAllEntries, getEntryById,
  getEntryIdByFilePath, getEntryCount, getNeighborsByEntryId, hasStoredEmbedding, resolveSourceEntries,
};
