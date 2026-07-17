// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * FROZEN copy of the pre-0.9.0 recognition/placement/ref-grammar/origin-
 * resolution surface — akm 0.9.0 chunk-1, WI-1.4, decision D1-6
 * (`docs/design/execution/chunk-1/brief.md`, `docs/design/execution/
 * chunk-1/anchors.md` §D). Seeds Chunk 8's migrator: it walks the OLD
 * on-disk layout per source with THIS frozen resolver and builds the
 * complete old-ref -> new-id map before any re-layout happens (normative
 * spec §11.4; plan §3.4/§3.3 item 2).
 *
 * ## Why a copy, not a re-export (the #1 chunk-1 trap)
 *
 * A textual copy that still IMPORTS the live modules it freezes is NOT
 * frozen — it breaks the moment those modules change, which for two of them
 * is one/two chunks away:
 *
 *   1. `src/core/asset/asset-ref.ts` imports `{ isAssetType, AkmAssetType }`
 *      from `../common`. `isAssetType` is a DYNAMIC check
 *      (`Object.hasOwn(TYPE_DIRS, type)`) against the LIVE, evolving
 *      `TYPE_DIRS` — and `common.ts:29-88` (the whole `ASSET_TYPES`/
 *      `AkmAssetType`/`isAssetType` block) is deleted in Chunk 1.5, one
 *      chunk after this one closes.
 *   2. `src/core/asset/asset-spec.ts` imports `buildWorkflowAction` from
 *      `../../output/renderers` and `registerActionBuilder`/
 *      `registerTypeRenderer` from `./asset-registry`; `ASSET_SPECS_INTERNAL`
 *      carries `rendererName`/`actionBuilder` fields that call into that
 *      registry. Both `asset-registry.ts` and `output/renderers.ts`'s
 *      type-registry are deleted in Chunk 3.
 *
 * This file therefore imports NOTHING from `src/` — only Node builtins
 * (`node:fs`, `node:os`, `node:path`). Concretely (D1-6 a-d):
 *
 *   (a) §"Type snapshot" below INLINES a private closed-union of the 14
 *       type keys (`LEGACY_TYPE_KEYS`) instead of importing the live
 *       `isAssetType`/`TYPE_DIRS`. This is a frozen SNAPSHOT of what the 14
 *       built-in types were at this HEAD — it does NOT track types added
 *       later via the live `registerAssetType` (out of scope: the old
 *       on-disk layout this migrator walks never had dynamically-registered
 *       types persisted into it).
 *   (b) §"Narrowed AssetSpec" below drops `rendererName`/`actionBuilder`
 *       from the copied `AssetSpec` shape — the migrator builds an old-ref
 *       map, it never renders, so it has no need of the renderer registry
 *       those two fields call into.
 *   (c) §"Own extension constants" below is this file's OWN copy of
 *       `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName`,
 *       independent of the live `core/recognition-util.ts` util home (WI-1.2)
 *       — "so the live util home can evolve without touching the migrator"
 *       (plan §3.4, architecture-plan.md:138).
 *   (d) §"Ref grammar" and §"Origin -> source resolution" below copy the
 *       bare/origin-qualified/`.derived` ref shapes and
 *       `resolveSourcesForOrigin`/`isRemoteOrigin`/`parseRegistryRef`
 *       self-contained, with a documented narrowing on the last one (see
 *       that section's header comment) — it drops the LIVE network-fetching
 *       artifact-resolution functions (`resolveNpmArtifact` et al.), keeping
 *       only the pure ID-deriving parse logic `resolveSourcesForOrigin`
 *       actually consumes.
 *
 * ## Provenance (D.2 census table, chunk-1 anchors.md §D.2)
 *
 *  - `AssetSpec` interface + `ASSET_SPECS_INTERNAL` (all 14 types) +
 *    `TYPE_DIRS` + `isRelevantAssetFile`/`deriveCanonicalAssetName`/
 *    `deriveCanonicalAssetNameFromStashRoot`/`resolveAssetPathFromName` —
 *    `src/core/asset/asset-spec.ts` (whole file), NARROWED per (b) above.
 *  - `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName` —
 *    same file (moved to `core/recognition-util.ts` by WI-1.2; this copy
 *    predates and is independent of that move, per (c) above).
 *  - Ref grammar (bare + `.derived` key shapes) —
 *    `src/core/asset/asset-ref.ts` (whole file) +
 *    `src/commands/improve/memory/derived-ref.ts:37-83`
 *    (`DERIVED_SUFFIX`/`isDerivedMemory`/`resolveParentRef`). The concrete
 *    bare/origin-qualified/`.derived` pair algebra this resolver must
 *    reproduce is demonstrated today by `rekeyStateDbForMove`
 *    (`src/commands/mv-cli.ts:898-967`) — a good reference, not itself part
 *    of the freeze.
 *  - Origin -> source resolution — `src/registry/origin-resolve.ts` (whole
 *    file) + the pure ID-deriving core of its `parseRegistryRef` dependency
 *    (`src/registry/resolve.ts`), narrowed per (d) above.
 *
 * ## Deliberately NOT copied (out of WI-1.4 scope — chunk-1 anchors.md §D.1)
 *
 * `WORKFLOW_MIGRATIONS` (Chunk 8's frozen copy) and the pre-0.9 proposal
 * legacy-import fold (`proposal/legacy-import.ts`, Chunk 5's fold) share
 * this `migrate/legacy/` directory but are NOT this work item's deliverable
 * — do not add them here.
 *
 * ## Identifier names are intentionally UNCHANGED from their live sources
 *
 * The manifest's `grepGateScope` explicitly excludes `src/migrate/legacy/`
 * from every zero-count grep ("the frozen §3.4 copy retains dead
 * identifiers by design... do NOT rename identifiers inside the frozen copy
 * to appease greps"). Every exported name below (`AssetSpec`,
 * `ASSET_SPECS_INTERNAL`, `ASSET_SPECS`, `TYPE_DIRS`, `SCRIPT_EXTENSIONS`,
 * `WORKFLOW_EXTENSIONS`, `canonicalizeWorkflowName`, `DERIVED_SUFFIX`,
 * `AssetRef`, `makeAssetRef`, `parseAssetRef`, `isDerivedMemory`,
 * `resolveParentRef`, `resolveSourcesForOrigin`, `isRemoteOrigin`,
 * `parseRegistryRef`, ...) matches its live-module counterpart's name
 * exactly, by design.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ═══════════════════════════════════════════════════════════════════════
// Local, self-contained error type — replaces the live `UsageError`/
// `NotFoundError` (`src/core/errors.ts`) so this file imports nothing from
// `src/` at all, even a leaf that isn't currently delete-scheduled. Carries
// an optional `.code` for parity with the messages/codes the live modules
// threw, though the migrator only needs to catch-and-classify.
// ═══════════════════════════════════════════════════════════════════════

export class LegacyResolverError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "LegacyResolverError";
    this.code = code;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Type snapshot (D1-6a) — inlined closed union of the 14 built-in asset
// type keys, replacing the live `isAssetType`/`AkmAssetType`
// (`src/core/common.ts:29-88`, deleted Chunk 1.5). This is a frozen
// SNAPSHOT, not a dynamic registry lookup.
// ═══════════════════════════════════════════════════════════════════════

export const LEGACY_TYPE_KEYS = [
  "skill",
  "command",
  "agent",
  "knowledge",
  "workflow",
  "script",
  "memory",
  "env",
  "secret",
  "wiki",
  "lesson",
  "task",
  "session",
  "fact",
] as const;

export type LegacyAssetType = (typeof LEGACY_TYPE_KEYS)[number];

const LEGACY_TYPE_KEY_SET: ReadonlySet<string> = new Set(LEGACY_TYPE_KEYS);

/** Frozen-snapshot replacement for the live `isAssetType` (`core/common.ts:86-88`). */
export function isAssetType(type: string): type is LegacyAssetType {
  return LEGACY_TYPE_KEY_SET.has(type);
}

// ═══════════════════════════════════════════════════════════════════════
// Own extension constants (D1-6c) — independent copy of
// `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName`, not
// imported from the live `core/recognition-util.ts` util home.
// ═══════════════════════════════════════════════════════════════════════

/** All recognized script extensions for the script asset type. */
export const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".ts",
  ".js",
  ".ps1",
  ".cmd",
  ".bat",
  ".py",
  ".rb",
  ".go",
  ".pl",
  ".php",
  ".lua",
  ".r",
  ".swift",
  ".kt",
  ".kts",
]);

/**
 * Recognized workflow asset extensions, in resolution-priority order.
 * `.md` stays FIRST for back-compat; `.yaml`/`.yml` hold YAML workflow
 * programs.
 */
export const WORKFLOW_EXTENSIONS = [".md", ".yaml", ".yml"] as const;

/**
 * Strip a recognized workflow extension (`.md`/`.yaml`/`.yml`) from a
 * workflow asset *name* so `foo`, `foo.yaml`, `foo.yml`, and `foo.md`
 * collapse to one canonical identity.
 */
export function canonicalizeWorkflowName(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of WORKFLOW_EXTENSIONS) {
    if (lower.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/** Structural marker suffix for a derived (inferred) memory's canonical name. */
export const DERIVED_SUFFIX = ".derived";

// ═══════════════════════════════════════════════════════════════════════
// Narrowed AssetSpec (D1-6b) + ASSET_SPECS_INTERNAL — recognition/placement
// ONLY. `rendererName`/`actionBuilder` are DROPPED: the migrator builds an
// old-ref map, it never renders, and those fields call into
// `asset-registry.ts`/`output/renderers.ts` (both deleted Chunk 3).
// ═══════════════════════════════════════════════════════════════════════

export interface AssetSpec {
  stashDir: string;
  isRelevantFile: (fileName: string) => boolean;
  toCanonicalName: (typeRoot: string, filePath: string) => string | undefined;
  toAssetPath: (typeRoot: string, name: string) => string;
}

function toPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

const workflowSpec: Omit<AssetSpec, "stashDir"> = {
  isRelevantFile: (fileName) =>
    (WORKFLOW_EXTENSIONS as readonly string[]).includes(path.extname(fileName).toLowerCase()),
  toCanonicalName: (typeRoot, filePath) => {
    const rel = toPosix(path.relative(typeRoot, filePath));
    for (const ext of WORKFLOW_EXTENSIONS) {
      if (rel.toLowerCase().endsWith(ext)) return rel.slice(0, -ext.length);
    }
    return rel;
  },
  toAssetPath: (typeRoot, name) => {
    // Explicit extension wins (accepts refs like "release/ship.yaml").
    const lower = name.toLowerCase();
    for (const ext of WORKFLOW_EXTENSIONS) {
      if (lower.endsWith(ext)) return path.join(typeRoot, name);
    }
    // Probe in priority order — `.md` first for back-compat — and fall back
    // to the markdown path so error messages keep naming the canonical file.
    for (const ext of WORKFLOW_EXTENSIONS) {
      const candidate = path.join(typeRoot, `${name}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(typeRoot, `${name}.md`);
  },
};

const markdownSpec: Omit<AssetSpec, "stashDir"> = {
  isRelevantFile: (fileName) => path.extname(fileName).toLowerCase() === ".md",
  toCanonicalName: (typeRoot, filePath) => {
    const rel = toPosix(path.relative(typeRoot, filePath));
    return rel.endsWith(".md") ? rel.slice(0, -3) : rel;
  },
  toAssetPath: (typeRoot, name) => {
    const withExt = name.endsWith(".md") ? name : `${name}.md`;
    return path.join(typeRoot, withExt);
  },
};

const scriptSpec: Omit<AssetSpec, "stashDir"> = {
  isRelevantFile: (fileName) => SCRIPT_EXTENSIONS.has(path.extname(fileName).toLowerCase()),
  toCanonicalName: (typeRoot, filePath) => toPosix(path.relative(typeRoot, filePath)),
  toAssetPath: (typeRoot, name) => path.join(typeRoot, name),
};

export const ASSET_SPECS_INTERNAL: Record<string, AssetSpec> = {
  skill: {
    stashDir: "skills",
    isRelevantFile: (fileName) => fileName === "SKILL.md",
    toCanonicalName: (typeRoot, filePath) => {
      const relDir = toPosix(path.dirname(path.relative(typeRoot, filePath)));
      if (!relDir || relDir === ".") return undefined;
      return relDir;
    },
    toAssetPath: (typeRoot, name) => path.join(typeRoot, name, "SKILL.md"),
  },
  command: { stashDir: "commands", ...markdownSpec },
  agent: { stashDir: "agents", ...markdownSpec },
  knowledge: { stashDir: "knowledge", ...markdownSpec },
  workflow: { stashDir: "workflows", ...workflowSpec },
  script: { stashDir: "scripts", ...scriptSpec },
  memory: { stashDir: "memories", ...markdownSpec },
  env: {
    stashDir: "env",
    isRelevantFile: (fileName) => fileName === ".env" || fileName.endsWith(".env"),
    toCanonicalName: (typeRoot, filePath) => {
      const rel = toPosix(path.relative(typeRoot, filePath));
      const fileName = path.basename(rel);
      // Treat ".env" as the "default" env; "<name>.env" → "<name>"
      if (fileName === ".env") {
        const dir = path.dirname(rel);
        return dir === "." || dir === "" ? "default" : `${dir}/default`;
      }
      const stripped = rel.endsWith(".env") ? rel.slice(0, -4) : rel;
      return stripped;
    },
    toAssetPath: (typeRoot, name) => {
      if (name === "default") return path.join(typeRoot, ".env");
      return path.join(typeRoot, name.endsWith(".env") ? name : `${name}.env`);
    },
  },
  secret: {
    stashDir: "secrets",
    isRelevantFile: (fileName) => !fileName.endsWith(".lock") && !fileName.endsWith(".sensitive"),
    toCanonicalName: (typeRoot, filePath) => toPosix(path.relative(typeRoot, filePath)),
    toAssetPath: (typeRoot, name) => path.join(typeRoot, name),
  },
  wiki: {
    stashDir: "wikis",
    ...markdownSpec,
  },
  lesson: {
    stashDir: "lessons",
    ...markdownSpec,
  },
  task: {
    stashDir: "tasks",
    isRelevantFile: (fileName: string) => path.extname(fileName).toLowerCase() === ".yml",
    toCanonicalName: (typeRoot: string, filePath: string) => {
      const rel = toPosix(path.relative(typeRoot, filePath));
      return rel.endsWith(".yml") ? rel.slice(0, -4) : rel;
    },
    toAssetPath: (typeRoot: string, name: string) => {
      const withExt = name.endsWith(".yml") ? name : `${name}.yml`;
      return path.join(typeRoot, withExt);
    },
  },
  session: {
    stashDir: "sessions",
    ...markdownSpec,
  },
  fact: {
    stashDir: "facts",
    ...markdownSpec,
  },
};

export const ASSET_SPECS: Record<string, AssetSpec> = ASSET_SPECS_INTERNAL;

export const TYPE_DIRS: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_SPECS_INTERNAL).map(([type, spec]) => [type, spec.stashDir]),
);

export function isRelevantAssetFile(assetType: string, fileName: string): boolean {
  return ASSET_SPECS[assetType]?.isRelevantFile(fileName) ?? false;
}

export function deriveCanonicalAssetName(assetType: string, typeRoot: string, filePath: string): string | undefined {
  return ASSET_SPECS[assetType]?.toCanonicalName(typeRoot, filePath);
}

export function deriveCanonicalAssetNameFromStashRoot(
  assetType: string,
  stashRoot: string,
  filePath: string,
): string | undefined {
  const relPath = toPosix(path.relative(stashRoot, filePath));
  const segments = relPath.split("/").filter(Boolean);
  const firstSegment = segments[0];
  const typeRoot = firstSegment === TYPE_DIRS[assetType] ? path.join(stashRoot, firstSegment) : stashRoot;
  return deriveCanonicalAssetName(assetType, typeRoot, filePath);
}

export function resolveAssetPathFromName(assetType: string, typeRoot: string, name: string): string {
  const spec = ASSET_SPECS[assetType];
  if (!spec) throw new Error(`Unknown asset type: "${assetType}"`);
  return spec.toAssetPath(typeRoot, name);
}

// ═══════════════════════════════════════════════════════════════════════
// Ref grammar (D1-6d) — `[origin//]type:name` bare/origin-qualified shapes,
// self-contained: `isAssetType` above (the inlined snapshot) replaces the
// live `../common` import `asset-ref.ts:6` depends on.
// ═══════════════════════════════════════════════════════════════════════

export interface AssetRef {
  type: LegacyAssetType;
  name: string;
  /**
   * Where to find this asset.
   *   - undefined: search all sources (primary → search paths → installed)
   *   - "local": primary stash only
   *   - registry ref: e.g. "npm:@scope/pkg", "owner/repo", "github:owner/repo#v1"
   *   - filesystem path: e.g. "/mnt/shared-stash"
   */
  origin?: string;
}

/** Accepted spelling aliases mapping to a canonical asset type. */
const TYPE_ALIASES: Record<string, LegacyAssetType> = {
  environment: "env",
};

/**
 * Build a ref string from components.
 *
 * Examples:
 *   makeAssetRef("script", "deploy.sh") → "script:deploy.sh"
 *   makeAssetRef("script", "deploy.sh", "npm:@scope/pkg") → "npm:@scope/pkg//script:deploy.sh"
 */
export function makeAssetRef(type: LegacyAssetType, name: string, origin?: string): string {
  validateName(name);
  const normalized = normalizeName(name);
  const asset = `${type}:${normalized}`;
  if (!origin) return asset;
  return `${origin}//${asset}`;
}

/** Serialize a parsed {@link AssetRef} back to its canonical `[origin//]type:name` string form. */
export function refToString(ref: AssetRef): string {
  return makeAssetRef(ref.type, ref.name, ref.origin);
}

/** Parse a ref string in the format `[origin//]type:name`. */
export function parseAssetRef(ref: string): AssetRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new LegacyResolverError("Empty ref.", "MISSING_REQUIRED_ARGUMENT");

  let origin: string | undefined;
  let body = trimmed;

  const boundary = trimmed.indexOf("//");
  if (boundary >= 0) {
    origin = trimmed.slice(0, boundary);
    body = trimmed.slice(boundary + 2);
    if (!origin) throw new LegacyResolverError("Empty origin in ref.", "MISSING_REQUIRED_ARGUMENT");
  }

  const colon = body.indexOf(":");
  if (colon <= 0) {
    throw new LegacyResolverError(
      `Invalid ref "${trimmed}". Expected [origin//]type:name, e.g. skill:deploy or knowledge:guide.md`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const rawType = body.slice(0, colon);
  const rawName = body.slice(colon + 1);

  // The `vault` asset type was removed in 0.9.0. Point callers at its
  // replacements rather than failing with a generic unknown-type error.
  if (rawType === "vault") {
    throw new LegacyResolverError(
      "The `vault` asset type was removed in 0.9.0 — use `env:` (whole .env config) or `secret:` (a single value).",
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  // Type aliases: `environment:` is an accepted spelling of the canonical `env:` type.
  const resolvedType = TYPE_ALIASES[rawType] ?? rawType;

  if (!isAssetType(resolvedType)) {
    throw new LegacyResolverError(`Invalid asset type: "${rawType}".`, "MISSING_REQUIRED_ARGUMENT");
  }

  validateName(rawName);
  const name = normalizeName(rawName);

  return { type: resolvedType, name, origin: origin || undefined };
}

function validateName(name: string): void {
  if (!name) throw new LegacyResolverError("Empty asset name.", "MISSING_REQUIRED_ARGUMENT");
  if (name.includes("\0")) throw new LegacyResolverError("Null byte in asset name.", "MISSING_REQUIRED_ARGUMENT");
  if (/^[A-Za-z]:/.test(name)) {
    throw new LegacyResolverError("Windows drive path in asset name.", "MISSING_REQUIRED_ARGUMENT");
  }

  const normalized = path.posix.normalize(name.replace(/\\/g, "/"));
  if (path.posix.isAbsolute(normalized)) {
    throw new LegacyResolverError("Absolute path in asset name.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new LegacyResolverError("Path traversal in asset name.", "MISSING_REQUIRED_ARGUMENT");
  }
  const segments = normalized.split("/");
  if (segments.some((seg) => seg === "." || seg === "..")) {
    throw new LegacyResolverError("Asset name cannot contain relative path segments.", "MISSING_REQUIRED_ARGUMENT");
  }
}

function normalizeName(name: string): string {
  return path.posix.normalize(name.replace(/\\/g, "/"));
}

// ═══════════════════════════════════════════════════════════════════════
// `.derived` key shapes (D1-6d) — self-contained copy of
// `derived-ref.ts:37-83`'s `DERIVED_SUFFIX`/`isDerivedMemory`/
// `resolveParentRef`. `asNonEmptyString` is inlined (a two-line pure
// helper from `core/common.ts:537-541`) rather than imported.
// ═══════════════════════════════════════════════════════════════════════

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalise an arbitrary `source:`/edge string to a canonical `memory:<name>`
 * ref, or `undefined` when it is empty, unparseable, or not a memory ref.
 */
function parseMemoryRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = parseAssetRef(value.trim());
    if (parsed.type !== "memory") return undefined;
    return makeAssetRef(parsed.type, parsed.name);
  } catch {
    return undefined;
  }
}

/**
 * True when the named memory is a derived/inferred child — either it carries
 * `inferred: true` in its frontmatter or its name ends with the structural
 * `.derived` suffix.
 */
export function isDerivedMemory(name: string, frontmatter: Record<string, unknown>): boolean {
  return frontmatter.inferred === true || name.endsWith(DERIVED_SUFFIX);
}

/**
 * Resolve the parent (source) memory ref for a derived memory, or
 * `undefined` when none can be determined. Precedence: `frontmatter.source`,
 * then `frontmatter.derivedFrom`, then the `.derived` name suffix stripped.
 */
export function resolveParentRef(name: string, frontmatter: Record<string, unknown>): string | undefined {
  const fromSource = parseMemoryRef(asNonEmptyString(frontmatter.source));
  if (fromSource) return fromSource;

  const derivedFrom = asNonEmptyString(frontmatter.derivedFrom);
  if (derivedFrom) return makeAssetRef("memory", derivedFrom);

  if (name.endsWith(DERIVED_SUFFIX)) {
    return makeAssetRef("memory", name.slice(0, -DERIVED_SUFFIX.length));
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// Origin -> source resolution (D1-6d) — self-contained copy of
// `src/registry/origin-resolve.ts` (whole file) + the PURE ID-deriving core
// of its `parseRegistryRef` dependency (`src/registry/resolve.ts`).
//
// NARROWING (documented per the WI-1.4 brief's instruction: "if
// origin-resolve pulls deep config deps, copy the minimal pure logic and
// document any behavioral narrowing"): the live `parseRegistryRef` also
// backs `resolveRegistryArtifact` — network-fetching install-time artifact
// resolution (`resolveNpmArtifact`/`resolveGithubArtifact`/
// `resolveGitArtifact`, tarball/host trust validation, git remote
// ls-remote calls) that depends on `core/common.ts` (fetchWithRetry,
// jsonWithByteCap), `integrations/github.ts`, and `./semver.ts`.
// `resolveSourcesForOrigin` — the only consumer this migrator needs — uses
// ONLY `parsed.id` from a parsed ref, never the artifact-resolution
// functions. This copy therefore keeps every PURE, fs-only, ID-deriving
// parse branch (npm/github/git/local/http(s) shorthand -> `{source, ref,
// id}`) and DROPS the network-touching artifact resolvers entirely, along
// with `ParsedLocalRef.repoRoot` (a git-repo-root lookup only used by the
// dropped local-artifact resolver, never by `id` derivation). Also replaced:
// `SearchSource` (`src/indexer/search/search-source.ts`) narrowed to the
// local `LegacySource` type below (only `.path`/`.registryId` are read).
// ═══════════════════════════════════════════════════════════════════════

/** Narrowed stand-in for the live `SearchSource` — only the two fields `resolveSourcesForOrigin` reads. */
export interface LegacySource {
  path: string;
  registryId?: string;
}

/**
 * Given an origin string (from an AssetRef) and the full list of stash
 * sources, return the subset of sources to search.
 *
 * Resolution order:
 *   1. undefined   → all sources
 *   2. "local"     → primary stash only (first entry)
 *   3. exact match → source whose registryId matches verbatim
 *   4. parsed match → parse origin as a registry ref, match by parsed ID
 *   5. path match  → source whose resolved path matches the origin
 *   6. empty       → indicates a remote/uninstalled origin (caller decides)
 */
export function resolveSourcesForOrigin(origin: string | undefined, allSources: LegacySource[]): LegacySource[] {
  if (!origin) return allSources;

  // "local" means the primary stash (first entry)
  if (origin === "local") {
    return allSources.length > 0 ? [allSources[0]] : [];
  }

  // Exact registryId match (e.g. origin is "npm:@scope/pkg")
  const byExactId = allSources.filter((s) => s.registryId !== undefined && s.registryId === origin);
  if (byExactId.length > 0) return byExactId;

  // Parse origin as a registry ref and match by parsed ID.
  try {
    const parsed = parseRegistryRef(origin);
    const byParsedId = allSources.filter((s) => s.registryId !== undefined && s.registryId === parsed.id);
    if (byParsedId.length > 0) return byParsedId;
  } catch {
    // Not a valid registry ref — continue to path matching
  }

  // Match by resolved path (any source, including installed)
  const resolvedOrigin = path.resolve(origin);
  const byPath = allSources.filter((s) => path.resolve(s.path) === resolvedOrigin);
  if (byPath.length > 0) return byPath;

  // No match — origin may be remote/uninstalled
  return [];
}

/**
 * Check whether an origin refers to something that could be fetched
 * remotely (i.e. it looks like a registry ref but isn't installed locally).
 */
export function isRemoteOrigin(origin: string, allSources: LegacySource[]): boolean {
  if (origin === "local") return false;
  return resolveSourcesForOrigin(origin, allSources).length === 0;
}

export interface RegistryRefBase {
  source: "npm" | "github" | "git" | "local";
  ref: string;
  id: string;
}

export interface ParsedNpmRef extends RegistryRefBase {
  source: "npm";
  packageName: string;
  requestedVersionOrTag?: string;
}

export interface ParsedGithubRef extends RegistryRefBase {
  source: "github";
  owner: string;
  repo: string;
  requestedRef?: string;
}

export interface ParsedGitRef extends RegistryRefBase {
  source: "git";
  url: string;
  requestedRef?: string;
}

export interface ParsedLocalRef extends RegistryRefBase {
  source: "local";
  sourcePath: string;
}

export type ParsedRegistryRef = ParsedNpmRef | ParsedGithubRef | ParsedGitRef | ParsedLocalRef;

/**
 * Known prefixes `parseRegistryRef` handles as installable sources. Anything
 * with a colon that doesn't start with one of these is likely a registry
 * search result ID (e.g. `skills-sh:org/skills/name`).
 */
const KNOWN_PREFIXES = ["npm:", "github:", "git+", "file:", "http://", "https://"];

function detectRegistrySearchId(ref: string): string | undefined {
  const colonIdx = ref.indexOf(":");
  if (colonIdx < 1) return undefined;

  for (const prefix of KNOWN_PREFIXES) {
    if (ref.startsWith(prefix)) return undefined;
  }

  const prefix = ref.slice(0, colonIdx);
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) return undefined;

  const rest = ref.slice(colonIdx + 1);
  const segments = rest.split("/").filter(Boolean);
  const suggestedRef = segments.length >= 2 ? `github:${segments[0]}/${segments[1]}` : undefined;

  const lines = [
    `"${ref}" looks like a registry search result ID, not an installable ref.`,
    `The "${prefix}:" prefix is a registry identifier and cannot be passed to \`akm add\`.`,
    "",
  ];
  if (suggestedRef) {
    lines.push(`Try installing the source repository directly:`, `  akm add ${suggestedRef}`, "");
  }
  lines.push(
    "Or search for the installable ref:",
    `  akm search "${segments.length > 2 ? segments[segments.length - 1] : rest}" --source registry`,
    "Then install using the installRef value from the result:",
    "  akm add github:owner/repo",
    "  akm add npm:package-name",
  );
  return lines.join("\n");
}

/** Parse an install/origin ref string, deriving its `{source, ref, id}` — the pure ID-deriving core of the live `parseRegistryRef`. */
export function parseRegistryRef(rawRef: string): ParsedRegistryRef {
  const ref = rawRef.trim();
  if (!ref) throw new LegacyResolverError("Registry ref is required.");

  const registryIdHint = detectRegistrySearchId(ref);
  if (registryIdHint) {
    throw new LegacyResolverError(registryIdHint);
  }

  if (ref.startsWith("npm:")) {
    return parseNpmRef(ref.slice(4), ref);
  }
  if (ref.startsWith("github:")) {
    return parseGithubShorthand(ref.slice(7), ref);
  }
  if (ref.startsWith("git+")) {
    return parseGitUrl(stripGitTransport(ref), ref);
  }
  if (ref.startsWith("file:")) {
    return tryParseLocalRef(fileUriToPath(ref), true) as ParsedLocalRef;
  }
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    return parseRemoteUrl(ref);
  }
  const localRef = tryParseLocalRef(ref, isPathLikeRef(ref));
  if (localRef) {
    return localRef;
  }

  if (ref.startsWith("@") || !looksLikeGithubOwnerRepo(ref)) {
    return parseNpmRef(ref, ref);
  }

  return parseGithubShorthand(ref, ref);
}

function parseNpmRef(input: string, originalRef: string): ParsedNpmRef {
  const trimmed = input.trim();
  if (!trimmed) throw new LegacyResolverError("Invalid npm ref.");

  const parsed = splitNpmNameAndVersion(trimmed);
  validateNpmPackageName(parsed.packageName);

  return {
    source: "npm",
    ref: originalRef,
    id: `npm:${parsed.packageName}`,
    packageName: parsed.packageName,
    requestedVersionOrTag: parsed.requestedVersionOrTag,
  };
}

function parseGithubShorthand(input: string, originalRef: string): ParsedGithubRef {
  const [repoPart, requestedRef] = splitRefSuffix(input.trim());
  const segments = repoPart.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new LegacyResolverError("Invalid GitHub ref. Expected owner/repo or owner/repo#ref.");
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (!owner || !repo) {
    throw new LegacyResolverError("Invalid GitHub ref. Expected owner/repo.");
  }
  return {
    source: "github",
    ref: originalRef,
    id: `github:${owner}/${repo}`,
    owner,
    repo,
    requestedRef,
  };
}

function parseRemoteUrl(rawUrl: string): ParsedGithubRef | ParsedGitRef {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LegacyResolverError("Invalid registry URL.");
  }

  if (url.hostname === "github.com") {
    return parseGithubUrl(url, rawUrl);
  }

  return parseGitUrl(rawUrl, rawUrl);
}

function parseGithubUrl(url: URL, rawUrl: string): ParsedGithubRef {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new LegacyResolverError("Invalid GitHub URL. Expected https://github.com/owner/repo.");
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  const requestedRef = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;

  return {
    source: "github",
    ref: rawUrl,
    id: `github:${owner}/${repo}`,
    owner,
    repo,
    requestedRef,
  };
}

function parseGitUrl(input: string, originalRef: string): ParsedGitRef {
  const [urlPart, requestedRef] = splitRefSuffix(input.trim());
  if (!urlPart) throw new LegacyResolverError("Invalid git ref. A URL is required.");

  const normalized = urlPart.replace(/\.git$/i, "");

  return {
    source: "git",
    ref: originalRef,
    id: `git:${normalized}`,
    url: urlPart,
    requestedRef,
  };
}

function tryParseLocalRef(rawRef: string, explicitPath: boolean): ParsedLocalRef | undefined {
  const resolvedPath = path.resolve(rawRef);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    if (explicitPath) {
      throw new LegacyResolverError(`Local path not found: ${resolvedPath}`, "FILE_NOT_FOUND");
    }
    return undefined;
  }

  if (!stat.isDirectory()) {
    if (explicitPath) {
      throw new LegacyResolverError("Local add path must be a directory, but the provided path is not one.");
    }
    return undefined;
  }

  return {
    source: "local",
    ref: rawRef,
    id: `local:${toReadableLocalId(resolvedPath)}`,
    sourcePath: resolvedPath,
  };
}

function isPathLikeRef(ref: string): boolean {
  if (ref.startsWith("@")) return false;
  if (ref === "." || ref === "..") return true;
  if (path.isAbsolute(ref)) return true;
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith(".\\") || ref.startsWith("..\\")) {
    return true;
  }
  return ref.includes("/") || ref.includes("\\");
}

function splitNpmNameAndVersion(input: string): { packageName: string; requestedVersionOrTag?: string } {
  if (input.startsWith("@")) {
    const secondAt = input.indexOf("@", 1);
    if (secondAt > 0) {
      return {
        packageName: input.slice(0, secondAt),
        requestedVersionOrTag: input.slice(secondAt + 1) || undefined,
      };
    }
    return { packageName: input };
  }

  const at = input.lastIndexOf("@");
  if (at > 0) {
    return {
      packageName: input.slice(0, at),
      requestedVersionOrTag: input.slice(at + 1) || undefined,
    };
  }
  return { packageName: input };
}

function validateNpmPackageName(name: string): void {
  if (!name) throw new LegacyResolverError("Invalid npm package name: name is required.");
  if (name.length > 214) throw new LegacyResolverError(`Invalid npm package name: "${name}" exceeds 214 characters.`);
  if (name !== name.toLowerCase() && !name.startsWith("@")) {
    throw new LegacyResolverError(`Invalid npm package name: "${name}" must be lowercase.`);
  }
  if (name.startsWith(".") || name.startsWith("_")) {
    throw new LegacyResolverError(`Invalid npm package name: "${name}" cannot start with . or _.`);
  }
  if (
    /[~'!()*]/.test(name) ||
    name.includes(" ") ||
    encodeURIComponent(name)
      .replace(/%40/g, "@")
      .replace(/%2[Ff]/g, "/") !== name
  ) {
    throw new LegacyResolverError(`Invalid npm package name: "${name}" contains invalid characters.`);
  }
}

function looksLikeGithubOwnerRepo(ref: string): boolean {
  const [repoPart] = splitRefSuffix(ref);
  const parts = repoPart.split("/").filter(Boolean);
  return parts.length === 2;
}

function splitRefSuffix(value: string): [string, string | undefined] {
  const hash = value.indexOf("#");
  if (hash < 0) return [value, undefined];
  return [value.slice(0, hash), value.slice(hash + 1) || undefined];
}

/** Strip the `git+` transport prefix from a ref, returning the inner URL. */
function stripGitTransport(ref: string): string {
  return ref.slice(4); // strip "git+"
}

/** Convert a `file:` URI to a local filesystem path. */
function fileUriToPath(ref: string): string {
  const after = ref.slice(5); // strip "file:"
  // Standard file:///absolute/path — delegate to Node's implementation
  if (after.startsWith("//")) {
    try {
      return fileURLToPath(ref);
    } catch {
      // Fall through to custom handling
    }
  }
  // Non-standard file:./relative or file:../relative or file:/absolute
  return after;
}

/**
 * Build a human-readable local ID from an absolute path.
 *   /home/user/akm/skills → ~/akm/skills
 *   /tmp/my-stash         → /tmp/my-stash
 */
function toReadableLocalId(absolutePath: string): string {
  const home = os.homedir();
  if (absolutePath === home) return "~";
  if (absolutePath.startsWith(home + path.sep)) {
    return `~/${absolutePath.slice(home.length + 1)}`;
  }
  return absolutePath;
}
