import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType, isAssetType } from "./common"
import { SCRIPT_EXTENSIONS, isRelevantAssetFile, deriveCanonicalAssetName } from "./asset-spec"
import { parseFrontmatter, toStringOrUndefined } from "./frontmatter"
import { parseMarkdownToc, type TocHeading } from "./markdown"
import { tryGetHandler } from "./asset-type-handler"

// ── Schema ──────────────────────────────────────────────────────────────────

export interface StashIntent {
  when?: string
  input?: string
  output?: string
}

export interface StashEntry {
  name: string
  type: AgentikitAssetType
  description?: string
  tags?: string[]
  examples?: string[]
  intents?: string[]
  intent?: StashIntent
  entry?: string
  generated?: boolean
  quality?: "generated" | "curated"
  confidence?: number
  source?: "package" | "frontmatter" | "comments" | "filename" | "manual" | "llm"
  aliases?: string[]
  toc?: TocHeading[]
  usage?: string[]
}

export interface StashFile {
  entries: StashEntry[]
}

// ── Load / Write ────────────────────────────────────────────────────────────

const STASH_FILENAME = ".stash.json"

export function stashFilePath(dirPath: string): string {
  return path.join(dirPath, STASH_FILENAME)
}

export function loadStashFile(dirPath: string): StashFile | null {
  const filePath = stashFilePath(dirPath)
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"))
    if (!raw || !Array.isArray(raw.entries)) return null
    const entries: StashEntry[] = []
    for (const e of raw.entries) {
      const validated = validateStashEntry(e)
      if (validated) {
        entries.push(validated)
      } else {
        const name = typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).name === "string"
          ? (e as Record<string, unknown>).name
          : "(unknown)"
        console.warn(`Warning: Skipping invalid entry "${name}" in ${filePath}`)
      }
    }
    return entries.length > 0 ? { entries } : null
  } catch {
    return null
  }
}

export function writeStashFile(dirPath: string, stash: StashFile): void {
  const filePath = stashFilePath(dirPath)
  const tmpPath = filePath + `.tmp.${process.pid}`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(stash, null, 2) + "\n", "utf8")
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore cleanup failure */ }
    throw err
  }
}

export function validateStashEntry(entry: unknown): StashEntry | null {
  if (typeof entry !== "object" || entry === null) return null
  const e = entry as Record<string, unknown>
  if (typeof e.name !== "string" || !e.name) return null
  if (typeof e.type !== "string" || !isAssetType(e.type)) return null

  const result: StashEntry = {
    name: e.name,
    type: e.type as AgentikitAssetType,
  }
  if (typeof e.description === "string" && e.description) result.description = e.description
  if (Array.isArray(e.tags)) result.tags = e.tags.filter((t): t is string => typeof t === "string")
  if (Array.isArray(e.examples)) result.examples = e.examples.filter((x): x is string => typeof x === "string")
  if (Array.isArray(e.intents)) {
    const filtered = e.intents.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    if (filtered.length > 0) result.intents = filtered
  }
  if (typeof e.intent === "object" && e.intent !== null) {
    const intent = e.intent as Record<string, unknown>
    result.intent = {}
    if (typeof intent.when === "string") result.intent.when = intent.when
    if (typeof intent.input === "string") result.intent.input = intent.input
    if (typeof intent.output === "string") result.intent.output = intent.output
  }
  if (typeof e.entry === "string" && e.entry) result.entry = e.entry
  if (e.generated === true) result.generated = true
  if (e.quality === "generated" || e.quality === "curated") result.quality = e.quality
  if (typeof e.confidence === "number" && Number.isFinite(e.confidence)) result.confidence = Math.max(0, Math.min(1, e.confidence))
  if (typeof e.source === "string" && ["package", "frontmatter", "comments", "filename", "manual", "llm"].includes(e.source)) {
    result.source = e.source as StashEntry["source"]
  }
  if (Array.isArray(e.aliases)) {
    const filtered = e.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    if (filtered.length > 0) result.aliases = normalizeTerms(filtered)
  }
  if (Array.isArray(e.toc)) {
    const validated = e.toc.filter(
      (h: unknown): h is TocHeading => {
        if (typeof h !== "object" || h === null) return false
        const rec = h as Record<string, unknown>
        return typeof rec.level === "number"
          && typeof rec.text === "string"
          && typeof rec.line === "number"
      },
    )
    if (validated.length > 0) result.toc = validated
  }
  const usage = normalizeNonEmptyStringList(e.usage)
  if (usage) result.usage = usage

  return result
}

function normalizeNonEmptyStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : undefined
  }
  if (!Array.isArray(value)) return undefined
  const filtered = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return filtered.length > 0 ? filtered : undefined
}

// ── Metadata Generation ─────────────────────────────────────────────────────

export function generateMetadata(
  dirPath: string,
  assetType: AgentikitAssetType,
  files: string[],
  typeRoot = dirPath,
): StashFile {
  const entries: StashEntry[] = []
  const pkgMeta = extractPackageMetadata(dirPath)

  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    const baseName = path.basename(file, ext)
    const fileName = path.basename(file)

    // Skip non-relevant files
    if (!isRelevantAssetFile(assetType, fileName)) continue

    const canonicalName = assetType === "skill"
      ? deriveCanonicalAssetName(assetType, typeRoot, file) ?? baseName
      : baseName

    const entry: StashEntry = {
      name: canonicalName,
      type: assetType,
      generated: true,
      quality: "generated",
      confidence: 0.55,
      source: "filename",
    }

    // Priority 1: Package.json metadata
    if (pkgMeta) {
      if (pkgMeta.description && !entry.description) {
        entry.description = pkgMeta.description
        entry.source = "package"
        entry.confidence = 0.8
      }
      if (pkgMeta.keywords && pkgMeta.keywords.length > 0) entry.tags = normalizeTerms(pkgMeta.keywords)
    }

    // Priority 2: Frontmatter (for .md files -- overrides package.json description)
    if (ext === ".md") {
      const fm = extractFrontmatterDescription(file)
      if (fm) {
        entry.description = fm
        entry.source = "frontmatter"
        entry.confidence = 0.9
      }
    }

    // Priority 3: Type-specific metadata extraction (e.g. TOC for knowledge, comments for tools/scripts)
    const handler = tryGetHandler(assetType)
    if (handler?.extractTypeMetadata) {
      handler.extractTypeMetadata(entry, file, ext)
    }

    // Priority 4: Filename heuristics (fallback)
    if (!entry.description) {
      entry.description = fileNameToDescription(baseName)
      entry.source = "filename"
      entry.confidence = Math.min(entry.confidence ?? 0.55, 0.55)
    }
    if (!entry.tags || entry.tags.length === 0) {
      entry.tags = extractTagsFromPath(file, dirPath)
    }

    entry.tags = normalizeTerms(entry.tags ?? [])
    entry.aliases = buildAliases(canonicalName, entry.tags)

    // Intents are only generated when LLM is configured (via enhanceStashWithLlm)
    // Heuristic intents are too noisy to be useful for search quality

    entry.entry = path.basename(file)
    entries.push(entry)
  }

  return { entries }
}


function normalizeTerms(values: string[]): string[] {
  const normalized = new Set<string>()
  for (const value of values) {
    const cleaned = value.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
    if (!cleaned) continue
    normalized.add(cleaned)
    if (cleaned.endsWith("s") && cleaned.length > 3) {
      normalized.add(cleaned.slice(0, -1))
    }
  }
  return Array.from(normalized)
}

function buildAliases(name: string, tags: string[]): string[] {
  const aliases = new Set<string>()
  const spaced = name.replace(/[-_]+/g, " ").trim().toLowerCase()
  if (spaced && spaced !== name.toLowerCase()) aliases.add(spaced)
  if (tags.length > 1) aliases.add(tags.join(" "))
  return Array.from(aliases)
}

export function extractDescriptionFromComments(filePath: string): string | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, "utf8")
  } catch {
    return null
  }

  const lines = content.split(/\r?\n/).slice(0, 50)

  // Try JSDoc-style block comment: /** ... */
  const blockStart = lines.findIndex((l) => /^\s*\/\*\*/.test(l))
  if (blockStart >= 0) {
    const desc: string[] = []
    for (let i = blockStart; i < lines.length; i++) {
      const line = lines[i]
      if (i > blockStart && /\*\//.test(line)) break
      const cleaned = line.replace(/^\s*\/?\*\*?\s?/, "").replace(/\*\/\s*$/, "").trim()
      if (cleaned) desc.push(cleaned)
    }
    if (desc.length > 0) return desc.join(" ")
  }

  // Try hash comments at start of file (skip shebang)
  let start = 0
  if (lines[0]?.startsWith("#!")) start = 1
  const hashLines: string[] = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith("#") && !line.startsWith("#!")) {
      hashLines.push(line.replace(/^#+\s*/, "").trim())
    } else if (line === "") {
      continue
    } else {
      break
    }
  }
  if (hashLines.length > 0) return hashLines.join(" ")

  return null
}

export function extractFrontmatterDescription(filePath: string): string | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, "utf8")
  } catch {
    return null
  }

  const parsed = parseFrontmatter(content)
  return toStringOrUndefined(parsed.data.description) ?? null
}

export function extractPackageMetadata(
  dirPath: string,
): { name?: string; description?: string; keywords?: string[] } | null {
  const pkgPath = path.join(dirPath, "package.json")
  if (!fs.existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    const result: { name?: string; description?: string; keywords?: string[] } = {}
    if (typeof pkg.name === "string") result.name = pkg.name
    if (typeof pkg.description === "string") result.description = pkg.description
    if (Array.isArray(pkg.keywords)) {
      result.keywords = pkg.keywords.filter((k: unknown): k is string => typeof k === "string")
    }
    return Object.keys(result).length > 0 ? result : null
  } catch {
    return null
  }
}

export function fileNameToDescription(fileName: string): string {
  return fileName
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim()
}

export function extractTagsFromPath(filePath: string, rootDir: string): string[] {
  const rel = path.relative(rootDir, filePath)
  const parts = rel.split(path.sep)
  const tags = new Set<string>()

  for (const part of parts) {
    const name = part.replace(path.extname(part), "")
    for (const token of name.split(/[-_./\\]+/)) {
      const clean = token.toLowerCase().trim()
      if (clean && clean.length > 1) tags.add(clean)
    }
  }

  return Array.from(tags)
}
