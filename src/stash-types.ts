import type { AgentikitAssetType } from "./common"
import type { ToolKind } from "./tool-runner"

export type AgentikitSearchType = AgentikitAssetType | "any"
export type SearchUsageMode = "none" | "both" | "item" | "guide"

export interface SearchHit {
  type: AgentikitAssetType
  name: string
  path: string
  openRef: string
  description?: string
  tags?: string[]
  score?: number
  whyMatched?: string[]
  runCmd?: string
  kind?: ToolKind
  usage?: string[]
}

export interface SearchResponse {
  stashDir: string
  hits: SearchHit[]
  usageGuide?: Partial<Record<AgentikitAssetType, string[]>>
  tip?: string
  /** Timing counters in milliseconds */
  timing?: { totalMs: number; rankMs?: number; embedMs?: number }
}

export interface ShowResponse {
  type: AgentikitAssetType
  name: string
  path: string
  content?: string
  template?: string
  prompt?: string
  description?: string
  toolPolicy?: unknown
  modelHint?: unknown
  runCmd?: string
  kind?: ToolKind
}

export type KnowledgeView =
  | { mode: "full" }
  | { mode: "toc" }
  | { mode: "frontmatter" }
  | { mode: "section"; heading: string }
  | { mode: "lines"; start: number; end: number }
