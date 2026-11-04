import { expect, test } from "bun:test";
import { removeEnv, writeEnv } from "../../src/commands/env/env";
import { setSecret, withSecretLock } from "../../src/commands/env/secret";
import { akmLint } from "../../src/commands/lint/index";
import { akmClone } from "../../src/commands/sources/source-clone";
import { akmTasksSync } from "../../src/commands/tasks/tasks";
import { handleApiRequest, NO_SUCH_ROUTE } from "../../src/commands/ui/api";
import {
  assertWriteLeaseFree,
  classifyProposalError,
  handleWriteRequest,
  matchWriteRoute,
} from "../../src/commands/ui/proposal-actions";
import { scrubUrlCredentials } from "../../src/commands/ui/redact";
import {
  classifyWorkspaceError,
  handleWorkspaceAction,
  matchWorkspaceAction,
} from "../../src/commands/ui/workspace-actions";
import { assetPathForName, deriveCanonicalAssetName, stashDirFor } from "../../src/core/asset/asset-placement";
import { parseRefInput } from "../../src/core/asset/resolve-ref";
import { renameBundle } from "../../src/core/bundle-rename";
import { isWithin, writeFileAtomic } from "../../src/core/common";
import { loadConfig } from "../../src/core/config/config";
import {
  resolveEnvPath,
  resolveEnvWriteTarget,
  resolveSecretPath,
  resolveSecretWriteTarget,
  sensitiveMarkerPath,
  withEnvSecretWrite,
} from "../../src/core/env-secret-ref";
import { AkmError, UsageError } from "../../src/core/errors";
import { resolveBundleWriteTarget } from "../../src/core/mutation-target";
import {
  assertAkmAssetWrite,
  prepareWriteTargetForMutation,
  withWriteTargetMutation,
} from "../../src/core/write-source";
import { withAssetMutationLease } from "../../src/indexer/index-writer-lock";
import { indexWrittenAssets } from "../../src/indexer/index-written-assets";
import { resolveSourceEntries } from "../../src/indexer/search/search-source";
import { closeDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import {
  getAllEntries,
  getEntryById,
  getEntryCount,
  getEntryIdByFilePath,
} from "../../src/storage/repositories/index-entries-repository";
import { getMeta } from "../../src/storage/repositories/index-meta-repository";
import {
  getAllEntriesForEmbedding,
  getNeighborsByEntryId,
  hasStoredEmbedding,
} from "../../src/storage/repositories/index-vec-repository";
import * as workspace from "../../src/workspace";

test("workspace exports exactly the existing operations, without wrappers or new behavior", () => {
  const existing: typeof workspace = {
    writeEnv,
    removeEnv,
    setSecret,
    withSecretLock,
    resolveEnvPath,
    resolveSecretPath,
    resolveEnvWriteTarget,
    resolveSecretWriteTarget,
    akmTasksSync,
    renameBundle,
    withEnvSecretWrite,
    sensitiveMarkerPath,
    deriveCanonicalAssetName,
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
    AkmError,
    UsageError,
    getAllEntriesForEmbedding,
    getMeta,
    loadConfig,
    resolveBundleWriteTarget,
    assertAkmAssetWrite,
    prepareWriteTargetForMutation,
    withWriteTargetMutation,
    isWithin,
    writeFileAtomic,
    assetPathForName,
    stashDirFor,
    parseRefInput,
    withAssetMutationLease,
    assertWriteLeaseFree,
    indexWrittenAssets,
    akmLint,
    closeDatabase,
    openReadonlyExistingDatabase,
    getAllEntries,
    getEntryById,
    getEntryIdByFilePath,
    getEntryCount,
    getNeighborsByEntryId,
    hasStoredEmbedding,
    resolveSourceEntries,
  };
  expect(Object.keys(workspace).sort()).toEqual(Object.keys(existing).sort());
  expect(workspace).toEqual(existing);
});
