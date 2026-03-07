export { plugin } from "./src/plugin"
export { agentikitSearch, agentikitOpen, agentikitRun, agentikitInit } from "./src/stash"
export type {
  AgentikitAssetType,
  AgentikitSearchType,
  SearchHit,
  SearchResponse,
  OpenResponse,
  RunResponse,
  InitResponse,
  KnowledgeView,
} from "./src/stash"
export { agentikitIndex } from "./src/indexer"
export type { IndexResponse } from "./src/indexer"
export type { StashEntry, StashFile, StashIntent } from "./src/metadata"
export { resolveRg, isRgAvailable, ensureRg } from "./src/ripgrep"
export type { EnsureRgResult } from "./src/ripgrep"
export { parseMarkdownToc, extractSection, extractLineRange, extractFrontmatterOnly, formatToc } from "./src/markdown"
export type { TocHeading, KnowledgeToc } from "./src/markdown"
