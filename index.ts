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
} from "./src/stash"
export { agentikitIndex } from "./src/indexer"
export type { IndexResponse } from "./src/indexer"
export type { StashEntry, StashFile, StashIntent } from "./src/metadata"
