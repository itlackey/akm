import fs from "node:fs"
import path from "node:path"
import type { AgentikitAssetType } from "./stash"

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
  intent?: StashIntent
  entry?: string
  generated?: boolean
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
      if (validated) entries.push(validated)
    }
    return entries.length > 0 ? { entries } : null
  } catch {
    return null
  }
}

export function writeStashFile(dirPath: string, stash: StashFile): void {
  const filePath = stashFilePath(dirPath)
  fs.writeFileSync(filePath, JSON.stringify(stash, null, 2) + "\n", "utf8")
}

export function validateStashEntry(entry: unknown): StashEntry | null {
  if (typeof entry !== "object" || entry === null) return null
  const e = entry as Record<string, unknown>
  if (typeof e.name !== "string" || !e.name) return null
  if (typeof e.type !== "string" || !isValidType(e.type)) return null

  const result: StashEntry = {
    name: e.name,
    type: e.type as AgentikitAssetType,
  }
  if (typeof e.description === "string" && e.description) result.description = e.description
  if (Array.isArray(e.tags)) result.tags = e.tags.filter((t): t is string => typeof t === "string")
  if (Array.isArray(e.examples)) result.examples = e.examples.filter((x): x is string => typeof x === "string")
  if (typeof e.intent === "object" && e.intent !== null) {
    const intent = e.intent as Record<string, unknown>
    result.intent = {}
    if (typeof intent.when === "string") result.intent.when = intent.when
    if (typeof intent.input === "string") result.intent.input = intent.input
    if (typeof intent.output === "string") result.intent.output = intent.output
  }
  if (typeof e.entry === "string" && e.entry) result.entry = e.entry
  if (e.generated === true) result.generated = true

  return result
}

function isValidType(type: string): boolean {
  return type === "tool" || type === "skill" || type === "command" || type === "agent"
}

// ── Metadata Generation ─────────────────────────────────────────────────────

const SCRIPT_EXTENSIONS = new Set([".sh", ".ts", ".js", ".ps1", ".cmd", ".bat"])

export function generateMetadata(
  dirPath: string,
  assetType: AgentikitAssetType,
  files: string[],
): StashFile {
  const entries: StashEntry[] = []

  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    const baseName = path.basename(file, ext)

    // Skip non-relevant files
    if (assetType === "tool" && !SCRIPT_EXTENSIONS.has(ext)) continue
    if ((assetType === "command" || assetType === "agent") && ext !== ".md") continue
    if (assetType === "skill" && path.basename(file) !== "SKILL.md") continue

    const entry: StashEntry = {
      name: baseName,
      type: assetType,
      generated: true,
    }

    // Priority 3: package.json metadata
    const pkgMeta = extractPackageMetadata(dirPath)
    if (pkgMeta) {
      if (pkgMeta.description && !entry.description) entry.description = pkgMeta.description
      if (pkgMeta.keywords && pkgMeta.keywords.length > 0) entry.tags = pkgMeta.keywords
    }

    // Priority 2: Frontmatter (for .md files)
    if (ext === ".md") {
      const fm = extractFrontmatterDescription(file)
      if (fm) entry.description = fm
    }

    // Priority 4: Code comments (for script files)
    if (SCRIPT_EXTENSIONS.has(ext) && ext !== ".md") {
      const commentDesc = extractDescriptionFromComments(file)
      if (commentDesc && !entry.description) entry.description = commentDesc
    }

    // Priority 5: Filename heuristics (fallback)
    if (!entry.description) {
      entry.description = fileNameToDescription(baseName)
    }
    if (!entry.tags || entry.tags.length === 0) {
      entry.tags = extractTagsFromPath(file, dirPath)
    }

    entry.entry = path.basename(file)
    entries.push(entry)
  }

  return { entries }
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

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null

  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^description:\s*"?(.+?)"?\s*$/)
    if (m) return m[1]
  }
  return null
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
