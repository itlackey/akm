import type { StashEntry } from "./metadata"
import type { LocalSearchHit, ShowResponse, KnowledgeView } from "./stash-types"
import { UsageError } from "./errors"

// ── Interface ────────────────────────────────────────────────────────────────

export interface ShowInput {
  name: string
  path: string
  content: string
  view?: KnowledgeView
  stashDirs?: string[]
}

export interface AssetTypeHandler {
  /** The type name, e.g. "tool", "script" */
  readonly typeName: string
  /** Directory inside the stash root, e.g. "tools", "scripts" */
  readonly stashDir: string

  // -- File system spec --
  isRelevantFile(fileName: string): boolean
  toCanonicalName(typeRoot: string, filePath: string): string | undefined
  toAssetPath(typeRoot: string, name: string): string

  // -- Show behavior --
  buildShowResponse(input: ShowInput): ShowResponse

  // -- Search enrichment --
  enrichSearchHit?(hit: LocalSearchHit, stashDir: string): void

  // -- Usage guide --
  readonly defaultUsageGuide: string[]

  // -- Metadata generation hooks --
  extractTypeMetadata?(entry: StashEntry, file: string, ext: string): void
}

// ── Registry ─────────────────────────────────────────────────────────────────

const handlers = new Map<string, AssetTypeHandler>()

let handlersInitialized = false

function ensureHandlersRegistered(): void {
  if (handlersInitialized) return
  handlersInitialized = true
  // Import handler registrations
  require("./handlers/index")
}

export function registerAssetType(handler: AssetTypeHandler): void {
  handlers.set(handler.typeName, handler)
}

export function getHandler(type: string): AssetTypeHandler {
  ensureHandlersRegistered()
  const handler = handlers.get(type)
  if (!handler) {
    throw new UsageError(`Unknown asset type: "${type}"`)
  }
  return handler
}

export function tryGetHandler(type: string): AssetTypeHandler | undefined {
  ensureHandlersRegistered()
  return handlers.get(type)
}

export function getAllHandlers(): AssetTypeHandler[] {
  ensureHandlersRegistered()
  return Array.from(handlers.values())
}

export function getRegisteredTypeNames(): string[] {
  ensureHandlersRegistered()
  return Array.from(handlers.keys())
}
