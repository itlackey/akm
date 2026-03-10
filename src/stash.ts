export type { AgentikitAssetType } from "./common"
export { resolveStashDir } from "./common"
export { agentikitInit } from "./init"
export type { InitResponse } from "./init"
export type { ToolKind } from "./tool-runner"
export type { AssetTypeHandler, ShowInput } from "./asset-type-handler"
export { registerAssetType, getHandler, getAllHandlers, getRegisteredTypeNames } from "./asset-type-handler"

// New flexible asset resolution system
export type {
  FileContext,
  MatchResult,
  AssetMatcher,
  RenderContext,
  AssetRenderer,
} from "./file-context"
export {
  buildFileContext,
  registerMatcher,
  registerRenderer,
  getRenderer,
  getAllRenderers,
  runMatchers,
  buildRenderContext,
} from "./file-context"
export { walkStashFlat } from "./walker"

export { agentikitSearch } from "./stash-search"
export { agentikitShow } from "./stash-show"
export { agentikitAdd } from "./stash-add"
export { agentikitClone } from "./stash-clone"

export { agentikitList, agentikitRemove, agentikitUpdate } from "./stash-registry"
export { checkForUpdate, performUpgrade } from "./self-update"
export { resolveStashSources, resolveAllStashDirs, findSourceForPath, getPrimarySource, isEditable } from "./stash-source"
export type { StashSource } from "./stash-source"

export type {
  AddResponse,
  AgentikitSearchType,
  LocalSearchHit,
  RegistrySearchResultHit,
  SearchSource,
  SearchUsageMode,
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
} from "./stash-types"

export type { CloneOptions, CloneResponse } from "./stash-clone"
