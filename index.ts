export {
  agentikitAdd,
  agentikitClone,
  agentikitList,
  agentikitRemove,
  agentikitSearch,
  agentikitShow,
  agentikitUpdate,
  checkForUpdate,
  performUpgrade,
  resolveStashSources,
  resolveAllStashDirs,
  findSourceForPath,
} from "./src/stash"
export { agentikitInit } from "./src/init"
export type { InitResponse } from "./src/init"
export type {
  AgentikitAssetType,
  AgentikitSearchType,
  AddResponse,
  LocalSearchHit,
  RegistrySearchResultHit,
  SearchSource,
  SearchHit,
  SearchResponse,
  ShowResponse,
  KnowledgeView,
  ListResponse,
  RemoveResponse,
  UpdateResponse,
  RegistryListEntry,
  RegistryInstallStatus,
  UpdateResultItem,
  UpgradeCheckResponse,
  UpgradeResponse,
  StashSource,
  StashSourceKind,
  CloneOptions,
  CloneResponse,
} from "./src/stash"
export type { ToolKind } from "./src/tool-runner"
export { agentikitIndex } from "./src/indexer"
export type { IndexResponse } from "./src/indexer"
export type { StashEntry, StashFile, StashIntent } from "./src/metadata"
export type { EnsureRgResult } from "./src/ripgrep"
export type { TocHeading, KnowledgeToc } from "./src/markdown"
export { loadConfig, saveConfig, updateConfig } from "./src/config"
export type { AgentikitConfig, EmbeddingConnectionConfig, LlmConnectionConfig, RegistryConfig } from "./src/config"
export { parseRegistryRef } from "./src/registry-resolve"
export { searchRegistry } from "./src/registry-search"
export { agentikitSubmit } from "./src/submit"
export { installRegistryRef } from "./src/registry-install"
export type {
  RegistrySource,
  ParsedRegistryRef,
  ParsedNpmRef,
  ParsedGithubRef,
  ResolvedRegistryArtifact,
  RegistryInstalledEntry,
  RegistryInstallResult,
  RegistrySearchHit,
  RegistrySearchResponse,
} from "./src/registry-types"
export type { AgentikitSubmitOptions, SubmitResponse } from "./src/submit"
export { readLockfile, writeLockfile, upsertLockEntry, removeLockEntry } from "./src/lockfile"
export type { LockfileEntry } from "./src/lockfile"
export { enhanceMetadata, isLlmAvailable } from "./src/llm"
export { embed, cosineSimilarity, isEmbeddingAvailable } from "./src/embedder"
export type { EmbeddingVector } from "./src/embedder"
export type { SearchUsageMode } from "./src/stash-types"
export type { AssetTypeHandler, ShowInput } from "./src/asset-type-handler"
export { registerAssetType, getHandler, tryGetHandler, getAllHandlers, getRegisteredTypeNames } from "./src/asset-type-handler"
export { parseAssetRef, makeAssetRef } from "./src/stash-ref"
export type { AssetRef } from "./src/stash-ref"
export { resolveSourcesForOrigin, isRemoteOrigin } from "./src/origin-resolve"

// New flexible asset resolution system
export type {
  FileContext,
  MatchResult,
  AssetMatcher,
  RenderContext,
  AssetRenderer,
} from "./src/file-context"
export {
  buildFileContext,
  registerMatcher,
  registerRenderer,
  getRenderer,
  getAllRenderers,
  runMatchers,
  buildRenderContext,
} from "./src/file-context"
export { walkStashFlat } from "./src/walker"
