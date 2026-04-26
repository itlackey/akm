import fs from "node:fs";
import path from "node:path";
import {
  deriveCanonicalAssetName,
  deriveCanonicalAssetNameFromStashRoot,
  isRelevantAssetFile,
} from "../core/asset-spec";
import { isAssetType } from "../core/common";
import { parseFrontmatter, toStringOrUndefined } from "../core/frontmatter";
import type { TocHeading } from "../core/markdown";
import { warn } from "../core/warn";
import { buildFileContext, buildRenderContext, getRenderer, runMatchers } from "./file-context";

// ── Schema ──────────────────────────────────────────────────────────────────

export interface StashIntent {
  when?: string;
  input?: string;
  output?: string;
}

export interface AssetParameter {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface StashEntry {
  name: string;
  type: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  searchHints?: string[];
  intent?: StashIntent;
  filename?: string;
  quality?: "generated" | "curated";
  confidence?: number;
  source?: "package" | "frontmatter" | "comments" | "filename" | "manual" | "llm";
  aliases?: string[];
  toc?: TocHeading[];
  usage?: string[];
  /** How to run this asset (e.g. "bash deploy.sh", "bun run.ts") */
  run?: string;
  /** Setup command to run before execution (e.g. "bun install") */
  setup?: string;
  /** Working directory for execution */
  cwd?: string;
  /** File size in bytes for output sizing hints */
  fileSize?: number;
  /** Structured parameter definitions extracted from the asset content */
  parameters?: AssetParameter[];
  /**
   * Wiki role for knowledge pages following the LLM Wiki pattern.
   * `schema` / `index` / `log` are the special files at the top of the wiki;
   * `raw` marks immutable ingested sources; `page` (default) is an LLM-authored page.
   */
  wikiRole?: "schema" | "index" | "log" | "raw" | "page";
  /**
   * Page archetype for wiki pages. Any non-empty string is accepted so users
   * can introduce categories freely (e.g. `entity`, `concept`, `question`,
   * `note`, `decision-record`). Wiki conventions live in `schema.md`.
   */
  pageKind?: string;
  /** Cross-references to other knowledge entries by ref (e.g. "knowledge:auth-design"). */
  xrefs?: string[];
  /** Source identifiers this page was distilled from (typically `raw/<slug>` files). */
  sources?: string[];
}

export interface StashFile {
  entries: StashEntry[];
  warnings?: string[];
}

// ── Load / Write ────────────────────────────────────────────────────────────

const STASH_FILENAME = ".stash.json";

export function stashFilePath(dirPath: string): string {
  return path.join(dirPath, STASH_FILENAME);
}

export function loadStashFile(dirPath: string): StashFile | null {
  const filePath = stashFilePath(dirPath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || !Array.isArray(raw.entries)) return null;
    const entries: StashEntry[] = [];
    for (const e of raw.entries) {
      const validated = validateStashEntry(e);
      if (validated) {
        entries.push(validated);
      } else {
        const name =
          typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).name === "string"
            ? (e as Record<string, unknown>).name
            : "(unknown)";
        warn(`Warning: Skipping invalid entry "${name}" in ${filePath}`);
      }
    }
    return entries.length > 0 ? { entries } : null;
  } catch {
    return null;
  }
}

export function writeStashFile(dirPath: string, stash: StashFile): void {
  const filePath = stashFilePath(dirPath);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(stash, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/**
 * Validate and normalize a raw object into a `StashEntry`.
 *
 * **Ordering dependency:** Uses `isAssetType()` to check `entry.type`, which
 * only recognizes custom types registered via `registerAssetType()`. If this
 * function is called before custom types are registered, those entries will be
 * rejected as invalid.
 */
export function validateStashEntry(entry: unknown): StashEntry | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.name !== "string" || !e.name) return null;
  if (typeof e.type !== "string" || !isAssetType(e.type)) return null;

  const result: StashEntry = {
    name: e.name,
    type: e.type as string,
  };
  if (typeof e.description === "string" && e.description) result.description = e.description;
  if (Array.isArray(e.tags)) result.tags = e.tags.filter((t): t is string => typeof t === "string");
  if (Array.isArray(e.examples)) result.examples = e.examples.filter((x): x is string => typeof x === "string");
  if (Array.isArray(e.searchHints)) {
    const filtered = e.searchHints.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (filtered.length > 0) result.searchHints = filtered;
  }
  if (typeof e.intent === "object" && e.intent !== null) {
    const intent = e.intent as Record<string, unknown>;
    result.intent = {};
    if (typeof intent.when === "string") result.intent.when = intent.when;
    if (typeof intent.input === "string") result.intent.input = intent.input;
    if (typeof intent.output === "string") result.intent.output = intent.output;
  }
  if (typeof e.filename === "string" && e.filename) result.filename = e.filename;
  if (e.quality === "generated" || e.quality === "curated") result.quality = e.quality;
  if (typeof e.confidence === "number" && Number.isFinite(e.confidence))
    result.confidence = Math.max(0, Math.min(1, e.confidence));
  if (
    typeof e.source === "string" &&
    ["package", "frontmatter", "comments", "filename", "manual", "llm"].includes(e.source)
  ) {
    result.source = e.source as StashEntry["source"];
  }
  if (Array.isArray(e.aliases)) {
    const filtered = e.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
    if (filtered.length > 0) result.aliases = normalizeTerms(filtered);
  }
  if (Array.isArray(e.toc)) {
    const validated = e.toc.filter((h: unknown): h is TocHeading => {
      if (typeof h !== "object" || h === null) return false;
      const rec = h as Record<string, unknown>;
      return typeof rec.level === "number" && typeof rec.text === "string" && typeof rec.line === "number";
    });
    if (validated.length > 0) result.toc = validated;
  }
  const usage = normalizeNonEmptyStringList(e.usage);
  if (usage) result.usage = usage;
  // SECURITY NOTE: run, setup, and cwd are advisory metadata fields for AI agent consumers.
  // They are NOT executed by akm directly. Consumers should validate and sanitize before execution.
  if (typeof e.run === "string" && e.run.trim()) result.run = e.run.trim();
  if (typeof e.setup === "string" && e.setup.trim()) result.setup = e.setup.trim();
  if (typeof e.cwd === "string" && e.cwd.trim()) result.cwd = e.cwd.trim();
  if (typeof e.fileSize === "number" && Number.isFinite(e.fileSize) && e.fileSize >= 0) result.fileSize = e.fileSize;
  if (
    e.wikiRole === "schema" ||
    e.wikiRole === "index" ||
    e.wikiRole === "log" ||
    e.wikiRole === "raw" ||
    e.wikiRole === "page"
  ) {
    result.wikiRole = e.wikiRole;
  }
  if (typeof e.pageKind === "string" && e.pageKind.trim().length > 0) {
    result.pageKind = e.pageKind.trim();
  }
  if (Array.isArray(e.xrefs)) {
    const filtered = e.xrefs
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim());
    if (filtered.length > 0) result.xrefs = filtered;
  }
  if (Array.isArray(e.sources)) {
    const filtered = e.sources
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    if (filtered.length > 0) result.sources = filtered;
  }
  if (Array.isArray(e.parameters)) {
    const validated = e.parameters
      .filter((p: unknown): p is AssetParameter => {
        if (typeof p !== "object" || p === null) return false;
        const rec = p as Record<string, unknown>;
        return typeof rec.name === "string" && rec.name.trim().length > 0;
      })
      .map((p: unknown) => {
        const rec = p as Record<string, unknown>;
        const param: AssetParameter = { name: (rec.name as string).trim() };
        if (typeof rec.type === "string" && rec.type.trim()) param.type = rec.type.trim();
        if (typeof rec.description === "string" && rec.description.trim()) param.description = rec.description.trim();
        if (typeof rec.required === "boolean") param.required = rec.required;
        if (typeof rec.default === "string" && rec.default.trim().length > 0) param.default = rec.default;
        return param;
      });
    if (validated.length > 0) result.parameters = validated;
  }

  return result;
}

function normalizeNonEmptyStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const filtered = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

// ── Parameter Extraction ─────────────────────────────────────────────────────

/**
 * Extract structured parameters from a command template containing
 * `$ARGUMENTS`, `$1`-`$9`, or `{{named}}` placeholders.
 */
export function extractCommandParameters(template: string): AssetParameter[] | undefined {
  const params: AssetParameter[] = [];

  if (/\$ARGUMENTS\b/.test(template)) {
    params.push({ name: "ARGUMENTS" });
  }

  for (const match of template.matchAll(/\$([1-9])(?!\d)/g)) {
    const name = `$${match[1]}`;
    if (!params.some((p) => p.name === name)) {
      params.push({ name });
    }
  }

  for (const match of template.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) {
    const name = match[1];
    if (!params.some((p) => p.name === name)) {
      params.push({ name });
    }
  }

  return params.length > 0 ? params : undefined;
}

/**
 * Extract wiki frontmatter fields (wikiRole, pageKind, xrefs, sources) from a parsed
 * frontmatter block and apply them to the entry. Tolerates missing or malformed values.
 */
export function applyWikiFrontmatter(entry: StashEntry, fmData: Record<string, unknown>): void {
  const role = fmData.wikiRole;
  if (role === "schema" || role === "index" || role === "log" || role === "raw" || role === "page") {
    entry.wikiRole = role;
  }
  const pageKind = fmData.pageKind;
  if (typeof pageKind === "string" && pageKind.trim().length > 0) {
    entry.pageKind = pageKind.trim();
  }
  const xrefs = fmData.xrefs;
  if (Array.isArray(xrefs)) {
    const filtered = xrefs
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim());
    if (filtered.length > 0) entry.xrefs = filtered;
  }
  const sources = fmData.sources;
  if (Array.isArray(sources)) {
    const filtered = sources
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    if (filtered.length > 0) entry.sources = filtered;
  }
}

const WIKI_INFRA_FILES = new Set(["schema.md", "index.md", "log.md"]);

/**
 * Apply wiki-specific index exclusions while leaving all other stash files
 * untouched.
 *
 * - In a normal stash, excludes wiki-root `schema.md`, `index.md`, `log.md`.
 * - In a wiki-root stash source (`wikiName`), excludes those same root-level
 *   infrastructure files.
 */
export function shouldIndexStashFile(
  stashRoot: string,
  file: string,
  options?: { treatStashRootAsWikiRoot?: boolean },
): boolean {
  const relPath = path.relative(stashRoot, file);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) return true;

  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return true;

  if (options?.treatStashRootAsWikiRoot) {
    return !(segments.length === 1 && WIKI_INFRA_FILES.has(segments[0]));
  }

  const wikisIdx = segments.indexOf("wikis");
  if (wikisIdx < 0 || wikisIdx + 1 >= segments.length) return true;

  const wikiRelativeSegments = segments.slice(wikisIdx + 2);
  if (wikiRelativeSegments.length === 0) return true;
  return !(wikiRelativeSegments.length === 1 && WIKI_INFRA_FILES.has(wikiRelativeSegments[0]));
}

/**
 * Extract `@param` JSDoc tags from a script file's leading comment block.
 *
 * Supports both JSDoc-style (`/** ... * /`) and hash-style (`# @param ...`)
 * comments. Optionally captures `{type}` annotations.
 */
export function extractScriptParameters(filePath: string, content?: string): AssetParameter[] | undefined {
  if (content === undefined) {
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return undefined;
    }
  }

  const lines = content.split(/\r?\n/).slice(0, 50);
  const params: AssetParameter[] = [];

  // Match @param lines in any comment style:
  // JSDoc:  * @param {string} name - description
  // JSDoc:  * @param name - description
  // Hash:   # @param name - description
  const paramRegex = /^[\s/*#;-]*@param\s+(?:\{([^}]+)\}\s+)?(\w+)(?:\s+-\s+(.+))?/;

  for (const line of lines) {
    const match = line.match(paramRegex);
    if (match) {
      const param: AssetParameter = { name: match[2] };
      if (match[1]) param.type = match[1].trim();
      if (match[3]) param.description = match[3].trim();
      params.push(param);
    }
  }

  return params.length > 0 ? params : undefined;
}

/**
 * Extract parameters from frontmatter `params:` key.
 *
 * The frontmatter parser produces a nested object for `params:` like:
 * ```
 * { region: "AWS region to deploy to", instance_type: "EC2 instance type" }
 * ```
 */
export function extractFrontmatterParameters(fmData: Record<string, unknown>): AssetParameter[] | undefined {
  const paramsRaw = fmData.params;
  if (typeof paramsRaw !== "object" || paramsRaw === null || Array.isArray(paramsRaw)) return undefined;

  const paramsObj = paramsRaw as Record<string, unknown>;
  const params: AssetParameter[] = [];

  for (const [key, value] of Object.entries(paramsObj)) {
    const param: AssetParameter = { name: key };
    if (typeof value === "string" && value.trim()) {
      param.description = value.trim();
    }
    params.push(param);
  }

  return params.length > 0 ? params : undefined;
}

/**
 * Merge two parameter lists, deduplicating by name.
 * Parameters from `additional` are appended only if their name is not already present.
 */
function mergeParameters(
  existing: AssetParameter[] | undefined,
  additional: AssetParameter[] | undefined,
): AssetParameter[] | undefined {
  if (!additional || additional.length === 0) return existing;
  if (!existing || existing.length === 0) return additional;

  const names = new Set(existing.map((p) => p.name));
  const merged = [...existing];
  for (const param of additional) {
    if (!names.has(param.name)) {
      merged.push(param);
      names.add(param.name);
    }
  }
  return merged;
}

// ── Metadata Generation ─────────────────────────────────────────────────────

export async function generateMetadata(
  dirPath: string,
  assetType: string,
  files: string[],
  typeRoot = dirPath,
): Promise<StashFile> {
  const entries: StashEntry[] = [];
  const warnings: string[] = [];
  const pkgMeta = extractPackageMetadata(dirPath);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const baseName = path.basename(file, ext);
    const fileName = path.basename(file);

    // Skip non-relevant files
    if (!isRelevantAssetFile(assetType, fileName)) continue;

    const canonicalName = deriveCanonicalAssetName(assetType, typeRoot, file) ?? baseName;

    const entry: StashEntry = {
      name: canonicalName,
      type: assetType,
      quality: "generated",
      confidence: 0.55,
      source: "filename",
    };

    // Priority 1: Package.json metadata
    if (pkgMeta) {
      if (pkgMeta.description && !entry.description) {
        entry.description = pkgMeta.description;
        entry.source = "package";
        entry.confidence = 0.8;
      }
      if (pkgMeta.keywords && pkgMeta.keywords.length > 0) entry.tags = normalizeTerms(pkgMeta.keywords);
    }

    // Priority 2: Frontmatter (for .md files -- overrides package.json description)
    if (ext === ".md") {
      const content = fs.readFileSync(file, "utf8");
      const parsed = parseFrontmatter(content);
      const fm = toStringOrUndefined(parsed.data.description);
      if (fm) {
        entry.description = fm;
        entry.source = "frontmatter";
        entry.confidence = 0.9;
      }
      // Extract parameters from frontmatter params: key
      const fmParams = extractFrontmatterParameters(parsed.data);
      if (fmParams) entry.parameters = fmParams;
      // Pass wiki-pattern frontmatter through onto the entry
      applyWikiFrontmatter(entry, parsed.data);
      // Extract parameters from template placeholders ($1, $ARGUMENTS, {{named}})
      if (entry.type === "command") {
        const cmdParams = extractCommandParameters(parsed.content);
        if (cmdParams) {
          entry.parameters = mergeParameters(entry.parameters, cmdParams);
        }
      }
    }

    // Extract @param from script files.
    // Vault files (.env) are deliberately excluded — their contents are secrets
    // and must never be parsed for @param or any other metadata that could
    // embed a value into the entry.
    if (ext !== ".md" && assetType !== "vault") {
      const scriptParams = extractScriptParameters(file);
      if (scriptParams) entry.parameters = scriptParams;
    }

    // Priority 3: Type-specific metadata extraction (e.g. TOC for knowledge, comments for scripts)
    const fileCtx = buildFileContext(typeRoot, file);
    const match = await runMatchers(fileCtx);
    if (match) {
      const renderer = await getRenderer(match.renderer);
      if (renderer?.extractMetadata) {
        const renderCtx = buildRenderContext(fileCtx, match, [typeRoot]);
        try {
          renderer.extractMetadata(entry, renderCtx);
        } catch (error) {
          warnings.push(buildMetadataSkipWarning(file, assetType, error));
          continue;
        }
      }
    }

    // Priority 4: Filename heuristics (fallback)
    if (!entry.description) {
      entry.description = fileNameToDescription(baseName);
      entry.source = "filename";
      entry.confidence = Math.min(entry.confidence ?? 0.55, 0.55);
    }
    if (!entry.tags || entry.tags.length === 0) {
      entry.tags = extractTagsFromPath(file, dirPath);
    }

    entry.tags = normalizeTerms(entry.tags ?? []);
    entry.aliases = buildAliases(canonicalName, entry.tags);

    // Search hints are only generated when LLM is configured (via enhanceStashWithLlm)
    // Heuristic search hints are too noisy to be useful for search quality

    entry.filename = path.basename(file);
    entries.push(entry);
  }

  return warnings.length > 0 ? { entries, warnings } : { entries };
}

/**
 * Generate metadata for files using the matcher system instead of a fixed asset type.
 *
 * This is the flat-walk counterpart of `generateMetadata`. It classifies each
 * file via `runMatchers()` and uses the matched type for canonical naming.
 * Files that no matcher claims are silently skipped.
 */
export async function generateMetadataFlat(stashRoot: string, files: string[]): Promise<StashFile> {
  const entries: StashEntry[] = [];
  const warnings: string[] = [];
  const pkgMetaCache = new Map<string, ReturnType<typeof extractPackageMetadata>>();

  for (const file of files) {
    if (!shouldIndexStashFile(stashRoot, file)) continue;
    const ctx = buildFileContext(stashRoot, file);
    const match = await runMatchers(ctx);
    if (!match) continue;

    const assetType = match.type;
    if (!isAssetType(assetType)) continue;

    // If the file lives under a known type directory, use that as the root
    // for canonical naming so names don't include the type prefix.
    // e.g. scripts/deploy.sh → "deploy.sh" not "scripts/deploy.sh"
    const ext = path.extname(file).toLowerCase();
    const baseName = path.basename(file, ext);
    const canonicalName = deriveCanonicalAssetNameFromStashRoot(assetType, stashRoot, file) ?? baseName;

    const entry: StashEntry = {
      name: canonicalName,
      type: assetType,
      quality: "generated",
      confidence: 0.55,
      source: "filename",
    };

    // Package.json metadata
    const dirPath = path.dirname(file);
    if (!pkgMetaCache.has(dirPath)) {
      pkgMetaCache.set(dirPath, extractPackageMetadata(dirPath));
    }
    const pkgMeta = pkgMetaCache.get(dirPath);
    if (pkgMeta) {
      if (pkgMeta.description && !entry.description) {
        entry.description = pkgMeta.description;
        entry.source = "package";
        entry.confidence = 0.8;
      }
      if (pkgMeta.keywords?.length) entry.tags = normalizeTerms(pkgMeta.keywords);
    }

    // Frontmatter
    if (ext === ".md") {
      const content = ctx.content();
      const parsed = parseFrontmatter(content);
      const fm = toStringOrUndefined(parsed.data.description);
      if (fm) {
        entry.description = fm;
        entry.source = "frontmatter";
        entry.confidence = 0.9;
      }
      // Extract parameters from frontmatter params: key
      const fmParams = extractFrontmatterParameters(parsed.data);
      if (fmParams) entry.parameters = fmParams;
      // Pass wiki-pattern frontmatter through onto the entry
      applyWikiFrontmatter(entry, parsed.data);
      // Extract parameters from template placeholders ($1, $ARGUMENTS, {{named}})
      if (entry.type === "command") {
        const cmdParams = extractCommandParameters(parsed.content);
        if (cmdParams) {
          entry.parameters = mergeParameters(entry.parameters, cmdParams);
        }
      }
    }

    // Extract @param from script files.
    // Vault files (.env) are deliberately excluded — their contents are secrets
    // and must never be parsed for @param or any other metadata that could
    // embed a value into the entry.
    if (ext !== ".md" && assetType !== "vault") {
      const scriptParams = extractScriptParameters(file, ctx.content());
      if (scriptParams) entry.parameters = scriptParams;
    }

    // Renderer metadata extraction
    const renderer = await getRenderer(match.renderer);
    if (renderer?.extractMetadata) {
      const renderCtx = buildRenderContext(ctx, match, [stashRoot]);
      try {
        renderer.extractMetadata(entry, renderCtx);
      } catch (error) {
        warnings.push(buildMetadataSkipWarning(file, assetType, error));
        continue;
      }
    }

    // Filename heuristics fallback
    if (!entry.description) {
      entry.description = fileNameToDescription(baseName);
      entry.source = "filename";
      entry.confidence = Math.min(entry.confidence ?? 0.55, 0.55);
    }
    if (!entry.tags || entry.tags.length === 0) {
      entry.tags = extractTagsFromPath(file, dirPath);
    }

    entry.tags = normalizeTerms(entry.tags ?? []);
    entry.aliases = buildAliases(canonicalName, entry.tags);
    entry.filename = path.basename(file);
    entries.push(entry);
  }

  return warnings.length > 0 ? { entries, warnings } : { entries };
}

function buildMetadataSkipWarning(filePath: string, assetType: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  // Workflow errors are already multi-line `path:line — message` blocks; print
  // them as-is so the author sees a flat list without a redundant prefix.
  const warning =
    assetType === "workflow"
      ? `Skipped workflow ${filePath}:\n${detail}`
      : `Skipped malformed ${assetType} asset at ${filePath}: ${detail}`;
  warn(warning);
  return warning;
}

function normalizeTerms(values: string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const cleaned = value.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    normalized.add(cleaned);
    // De-pluralization heuristic removed: the FTS5 porter stemmer (configured
    // with `tokenize='porter unicode61'`) handles stemming correctly, including
    // edge cases like "kubernetes" and "status" that the naive s-strip mangled.
  }
  return Array.from(normalized);
}

function buildAliases(name: string, tags: string[]): string[] {
  const aliases = new Set<string>();
  const spaced = name.replace(/[-_]+/g, " ").trim().toLowerCase();
  if (spaced && spaced !== name.toLowerCase()) aliases.add(spaced);
  if (tags.length > 1) aliases.add(tags.join(" "));
  return Array.from(aliases);
}

export function extractDescriptionFromComments(filePath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/).slice(0, 50);

  // Try JSDoc-style block comment: /** ... */
  const blockStart = lines.findIndex((l) => /^\s*\/\*\*/.test(l));
  if (blockStart >= 0) {
    const desc: string[] = [];
    for (let i = blockStart; i < lines.length; i++) {
      const line = lines[i];
      if (i > blockStart && /\*\//.test(line)) break;
      const cleaned = line
        .replace(/^\s*\/?\*\*?\s?/, "")
        .replace(/\*\/\s*$/, "")
        .trim();
      if (cleaned) desc.push(cleaned);
    }
    if (desc.length > 0) return desc.join(" ");
  }

  // Try hash comments at start of file (skip shebang)
  let start = 0;
  if (lines[0]?.startsWith("#!")) start = 1;
  const hashLines: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#") && !line.startsWith("#!")) {
      hashLines.push(line.replace(/^#+\s*/, "").trim());
    } else if (line === "") {
    } else {
      break;
    }
  }
  if (hashLines.length > 0) return hashLines.join(" ");

  return null;
}

export function extractFrontmatterDescription(filePath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const parsed = parseFrontmatter(content);
  return toStringOrUndefined(parsed.data.description) ?? null;
}

export function extractPackageMetadata(
  dirPath: string,
): { name?: string; description?: string; keywords?: string[] } | null {
  const pkgPath = path.join(dirPath, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const result: { name?: string; description?: string; keywords?: string[] } = {};
    if (typeof pkg.name === "string") result.name = pkg.name;
    if (typeof pkg.description === "string") result.description = pkg.description;
    if (Array.isArray(pkg.keywords)) {
      result.keywords = pkg.keywords.filter((k: unknown): k is string => typeof k === "string");
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

export function fileNameToDescription(fileName: string): string {
  return fileName
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

export function extractTagsFromPath(filePath: string, rootDir: string): string[] {
  const rel = path.relative(rootDir, filePath);
  const parts = rel.split(path.sep);
  const tags = new Set<string>();

  for (const part of parts) {
    const name = part.replace(path.extname(part), "");
    for (const token of name.split(/[-_./\\]+/)) {
      const clean = token.toLowerCase().trim();
      if (clean && clean.length > 1) tags.add(clean);
    }
  }

  return Array.from(tags);
}
