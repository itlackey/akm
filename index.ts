export {
  agentikitAdd,
  agentikitList,
  agentikitRemove,
  agentikitReinstall,
  agentikitSearch,
  agentikitShow,
  agentikitUpdate,
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
  ReinstallResponse,
  UpdateResponse,
  RegistryListEntry,
  RegistryInstallStatus,
  ReinstallResultItem,
  UpdateResultItem,
} from "./src/stash"
export type { ToolKind } from "./src/tool-runner"
export { agentikitIndex } from "./src/indexer"
export type { IndexResponse } from "./src/indexer"
export type { StashEntry, StashFile, StashIntent } from "./src/metadata"
export { resolveRg, isRgAvailable, ensureRg } from "./src/ripgrep"
export type { EnsureRgResult } from "./src/ripgrep"
export { parseMarkdownToc, extractSection, extractLineRange, extractFrontmatterOnly, formatToc } from "./src/markdown"
export type { TocHeading, KnowledgeToc } from "./src/markdown"
export { parseFrontmatter } from "./src/frontmatter"
export { loadConfig, saveConfig, updateConfig } from "./src/config"
export type { AgentikitConfig, EmbeddingConnectionConfig, LlmConnectionConfig, RegistryConfig } from "./src/config"
export { parseRegistryRef, resolveRegistryArtifact } from "./src/registry-resolve"
export { searchRegistry } from "./src/registry-search"
export {
  installRegistryRef,
  upsertInstalledRegistryEntry,
  removeInstalledRegistryEntry,
  getRegistryCacheRootDir,
  detectStashRoot,
} from "./src/registry-install"
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
export { enhanceMetadata, isLlmAvailable } from "./src/llm"
export { embed, cosineSimilarity, isEmbeddingAvailable } from "./src/embedder"
export type { EmbeddingVector } from "./src/embedder"
