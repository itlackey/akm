// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure recognition/placement layer for the built-in akm asset types — akm
 * 0.9.0 chunk-3 (the taxonomy-cutover leaf).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the `AssetSpec` filesystem
 * surface (`stashDir`/`isRelevantFile`/`toCanonicalName`/`toAssetPath`), the
 * per-type stash-subdir map, and the derive/resolve helpers built on them.
 * Chunk-3 deleted the mutable taxonomy globals that used to expose this data
 * as ambient registries; the surface is now reached through the small typed
 * accessors below (`stashDirFor`/`stashDirNames`/`placementTypes`/
 * `assetPathForName`/`placementSpecFor`), which the `akm` bundle adapter
 * (`adapter/adapters/akm-adapter.ts`) consumes for placement.
 *
 * ── Cycle-safety ──
 *
 * This leaf imports only Node builtins and the `core/recognition-util` pure
 * sink, so it is NOT an import-cycle (SCC) participant. Depending on it from
 * the `akm` adapter keeps the adapter a leaf. Renderer NAMES and action
 * builders for the built-in types live in the static `type-presentation.ts`
 * table (`TYPE_PRESENTATION`); they are intentionally absent here — placement
 * is a filesystem concern, presentation is a rendering concern.
 */

import fs from "node:fs";
import path from "node:path";
import { toPosix } from "../common";
import { DERIVED_SUFFIX, type KnownType, SCRIPT_EXTENSIONS, WORKFLOW_EXTENSIONS } from "../recognition-util";

export interface AssetSpec {
  stashDir: string;
  isRelevantFile: (fileName: string) => boolean;
  toCanonicalName: (typeRoot: string, filePath: string) => string | undefined;
  toAssetPath: (typeRoot: string, name: string) => string;
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
    // Probe in canonical extension priority order and fall back
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
    // Strip .md extension from canonical names.
    return rel.endsWith(".md") ? rel.slice(0, -3) : rel;
  },
  toAssetPath: (typeRoot, name) => {
    // Accept both with and without .md extension
    const withExt = name.endsWith(".md") ? name : `${name}.md`;
    return path.join(typeRoot, withExt);
  },
};

const scriptSpec: Omit<AssetSpec, "stashDir"> = {
  isRelevantFile: (fileName) => SCRIPT_EXTENSIONS.has(path.extname(fileName).toLowerCase()),
  toCanonicalName: (typeRoot, filePath) => toPosix(path.relative(typeRoot, filePath)),
  toAssetPath: (typeRoot, name) => path.join(typeRoot, name),
};

const BUILTIN_PLACEMENT_SPECS = {
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
  // R-045 / Q-18 second half (owner ruling 11, EXECUTE NOW) — `instruction` as
  // a real stash-resident type, mirroring `knowledge`'s plain markdown spec.
  // This is distinct from the ADAPTER-OWNED instruction docs emitted by
  // format-family adapters (root CLAUDE.md/AGENTS.md via `tool-dir-shared.ts`):
  // those carry `document.ownsPresentation === true` and are routed straight
  // to their adapter's own projection by `rendererForIndexedEntry`
  // (`src/commands/read/show.ts`), which checks `ownsPresentation` BEFORE
  // ever consulting a type/renderer mapping. A stash-resident `instructions/`
  // asset never sets that marker, so it always renders via the `knowledge-md`
  // renderer (`TYPE_PRESENTATION.instruction`, `src/core/type-presentation.ts`)
  // like any other placement type — no collision with the adapter-owned path.
  instruction: { stashDir: "instructions", ...markdownSpec },
  workflow: { stashDir: "workflows", ...workflowSpec },
  script: { stashDir: "scripts", ...scriptSpec },
  memory: { stashDir: "memories", ...markdownSpec },
  // Environment assets — whole `.env` files sourced/injected wholesale. Replaced
  // the deprecated `vault` type (removed in 0.9.0). Only key NAMES are surfaced
  // as metadata; values and comment text are never read for indexing (comments
  // routinely contain commented-out credentials).
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
  // Secrets — a single sensitive value used on its own for authentication (a
  // PEM key, API token, TLS cert). Unlike `env` (a group of related .env
  // configuration), the ENTIRE file is the one secret value — there is no safe
  // region to parse, so only the filename is ever surfaced as metadata. A
  // secret is any regular file under `secrets/` except `.lock`/`.sensitive`
  // sidecars; the canonical name preserves the natural filename.
  secret: {
    stashDir: "secrets",
    isRelevantFile: (fileName) => !fileName.endsWith(".lock") && !fileName.endsWith(".sensitive"),
    toCanonicalName: (typeRoot, filePath) => toPosix(path.relative(typeRoot, filePath)),
    toAssetPath: (typeRoot, name) => path.join(typeRoot, name),
  },
  // v1 spec §13 — `lesson` asset type. Required frontmatter fields are
  // `description` and `when_to_use`; lint enforces both.
  lesson: { stashDir: "lessons", ...markdownSpec },
  // Scheduled tasks. A task file pairs a cron-style schedule with a target
  // (workflow ref, prompt, or command). Stored as pure YAML under
  // <stash>/tasks/<id>.yml.
  task: {
    stashDir: "tasks",
    isRelevantFile: (fileName: string) => path.extname(fileName).toLowerCase() === ".yml",
    toCanonicalName: (typeRoot: string, filePath: string) => {
      const rel = toPosix(path.relative(typeRoot, filePath));
      return rel.toLowerCase().endsWith(".yml") ? rel.slice(0, -4) : rel;
    },
    toAssetPath: (typeRoot: string, name: string) => {
      const withExt = name.toLowerCase().endsWith(".yml") ? name : `${name}.yml`;
      return path.join(typeRoot, withExt);
    },
  },
  // #561 — agent sessions indexed as a first-class searchable asset type.
  // Generated markdown written by the `extract` pass to
  // `sessions/<harness>/<session-id>.md`.
  session: { stashDir: "sessions", ...markdownSpec },
  // Durable stash-level semantic knowledge — facts about the user, team, or
  // project. A plain markdown spec; see docs/architecture/specs/fact-asset-type.md.
  fact: { stashDir: "facts", ...markdownSpec },
} satisfies Record<string, AssetSpec>;

/**
 * Compile-time `placementTypes() ⊆ KNOWN_TYPES` subset assertion (owner
 * ruling 11): every key of the STATIC built-in table above must also be a
 * {@link KnownType} (`core/recognition-util.ts`), so the two registries can
 * never silently drift apart again. `satisfies Record<string, AssetSpec>`
 * above preserves the literal key union (a plain `Record<string, AssetSpec>`
 * annotation would widen it to `string` and defeat this check); if a future
 * edit adds a `BUILTIN_PLACEMENT_SPECS` key that is not in `KNOWN_TYPES`,
 * `_BuiltinPlacementKeysAreKnownTypes` resolves to `never` and the `= true`
 * assignment below fails to typecheck. This intentionally checks only the
 * static built-in table, NOT the mutable runtime registry mutated by
 * {@link registerAssetSpec} — the custom-asset-type extension surface is
 * allowed to register stash-resident specs for foreign (non-`KnownType`)
 * types.
 */
type _BuiltinPlacementKeysAreKnownTypes = keyof typeof BUILTIN_PLACEMENT_SPECS extends KnownType ? true : never;
const _placementKeysSubsetOfKnownTypes: _BuiltinPlacementKeysAreKnownTypes = true;
void _placementKeysSubsetOfKnownTypes;

const PLACEMENT_SPECS: Record<string, AssetSpec> = { ...BUILTIN_PLACEMENT_SPECS };

/** Live placement spec for a type, or `undefined` for an unknown type. */
export function placementSpecFor(type: string): AssetSpec | undefined {
  return PLACEMENT_SPECS[type];
}

/** Every registered placement spec (for whole-registry sweeps). */
export function placementSpecList(): readonly AssetSpec[] {
  return Object.values(PLACEMENT_SPECS);
}

/** Every registered placement type key (the set of types that have a stash subdir). */
export function placementTypes(): readonly string[] {
  return Object.keys(PLACEMENT_SPECS);
}

/** The stash subdir a type places into, or `undefined` for an unknown type. */
export function stashDirFor(type: string): string | undefined {
  return PLACEMENT_SPECS[type]?.stashDir;
}

/**
 * Reverse of {@link stashDirFor}: the placement type owning a stash subdir, or
 * `undefined` when no registered type places into it. The type→subdir map is a
 * bijection over the built-in types (each type has a distinct subdir), so this
 * is the well-defined inverse used to project a path-based conceptId onto the
 * asset-type metadata required by native adapters.
 */
export function typeForStashDir(stashDir: string): string | undefined {
  for (const [type, spec] of Object.entries(PLACEMENT_SPECS)) {
    if (spec.stashDir === stashDir) return type;
  }
  return undefined;
}

/** All stash subdir names across the registered types. */
export function stashDirNames(): string[] {
  return Object.values(PLACEMENT_SPECS).map((spec) => spec.stashDir);
}

/**
 * Mutate the placement registry to add/replace a type's spec. Used by the
 * custom-asset-type registration surface (extension types); built-ins are
 * baked into {@link PLACEMENT_SPECS} above.
 */
export function registerAssetSpec(type: string, spec: AssetSpec): void {
  PLACEMENT_SPECS[type] = spec;
}

/** Remove a previously-registered type's spec. */
export function deregisterAssetSpec(type: string): void {
  delete PLACEMENT_SPECS[type];
}

export function isRelevantAssetFile(assetType: string, fileName: string): boolean {
  return PLACEMENT_SPECS[assetType]?.isRelevantFile(fileName) ?? false;
}

export function deriveCanonicalAssetName(assetType: string, typeRoot: string, filePath: string): string | undefined {
  return PLACEMENT_SPECS[assetType]?.toCanonicalName(typeRoot, filePath);
}

export function deriveCanonicalAssetNameFromStashRoot(
  assetType: string,
  stashRoot: string,
  filePath: string,
): string | undefined {
  const relPath = toPosix(path.relative(stashRoot, filePath));
  const segments = relPath.split("/").filter(Boolean);
  const firstSegment = segments[0];
  // When the first segment matches the canonical type dir (e.g. "agents"),
  // use it as the type root so canonical names are relative to it.
  // Otherwise fall back to stashRoot — this preserves the full relative path
  // as the canonical name, which is correct for installed stashes that live
  // under custom directories (e.g. "tools/agents/svelte-file-editor").
  const typeRoot =
    firstSegment !== undefined && firstSegment === stashDirFor(assetType)
      ? path.join(stashRoot, firstSegment)
      : stashRoot;
  return deriveCanonicalAssetName(assetType, typeRoot, filePath);
}

export function assetPathForName(assetType: string, typeRoot: string, name: string): string {
  const spec = PLACEMENT_SPECS[assetType];
  if (!spec) throw new Error(`Unknown asset type: "${assetType}"`);
  return spec.toAssetPath(typeRoot, name);
}

/**
 * Every physical path spelling that could own `name`, closed-form (#857).
 * `toAssetPath` is a function, so it can only pick ONE spelling — but `env`'s
 * "default" alias is genuinely dual-owned: both `<dir>/.env` and
 * `<dir>/default.env` derive the same canonical name (`toCanonicalName`
 * above), so a physical-owner lookup must consider both without reading
 * either file. `memory` has a second, analogous duality (#882): a ref to
 * `<name>` may own either `<name>.md` or the LLM-inferred `<name>.derived.md`
 * twin — `.derived` is a provenance marker on the SAME identity, not part of
 * the name (see `resolveParentRef`/`isDerivedMemory` in
 * `commands/improve/memory/derived-ref.ts`, and the belief-edge identity
 * channel's own `memory:<name>.derived` refs). The plain `.md` file wins when
 * both exist, so it stays `primary` — first in the returned list — and every
 * caller here already prefers the first candidate that exists on disk. Every
 * other placement type has exactly one inverse spelling.
 */
export function assetPathCandidatesForName(assetType: string, typeRoot: string, name: string): string[] {
  const primary = assetPathForName(assetType, typeRoot, name);
  if (assetType === "memory" && !name.endsWith(DERIVED_SUFFIX)) {
    return [primary, assetPathForName(assetType, typeRoot, `${name}${DERIVED_SUFFIX}`)];
  }
  if (assetType !== "env") return [primary];
  const base = name === "default" ? "" : name.endsWith("/default") ? name.slice(0, -"default".length) : undefined;
  if (base === undefined) return [primary];
  const dotForm = path.join(typeRoot, base, ".env");
  const namedForm = path.join(typeRoot, base, "default.env");
  return [...new Set([primary, dotForm, namedForm])];
}

/**
 * Whether {@link assetPathCandidatesForName}'s returned list for `assetType`
 * is an ORDERED preference — earlier candidates are a declared winner over
 * later ones, so a physical-owner resolver may pick the earliest that exists
 * with no throw when more than one does — or a set of CO-EQUAL spellings,
 * where more than one existing together is a genuine authoring collision to
 * report, not a preference to resolve silently. #882's fix (the memory
 * `.derived`-twin bug) needs this distinction: attaching a declared rank to
 * every multi-candidate type's list turned `env`'s co-equal collision into a
 * silently-resolved false negative (#882 follow-up) — the two dualities this
 * module documents are NOT the same kind of thing.
 *
 * Only `memory` is ordered. Its own doc comment above states a winner in so
 * many words: "The plain `.md` file wins when both exist, so it stays
 * `primary`" — `.derived` is a provenance marker on the SAME identity, not a
 * second, independently-authored file.
 *
 * `env`'s `.env`/`default.env` duality is explicitly NOT ordered — the doc
 * comment above says only that both spellings "derive the same canonical
 * name" and a lookup "must consider both", never that one wins over the
 * other. They are two independently authored files that happen to collide
 * on one ref; both existing together is exactly the ambiguity
 * `AdapterConceptCollisionError` exists to report.
 *
 * Callers that attach a preference rank to distinguish a declared duality
 * from a genuine collision (`AdapterReadCandidate.priority`,
 * `resolveAdapterConceptOwner` in `indexer/lookup/adapter-concept-owner.ts`)
 * must consult this predicate per asset type rather than assuming every
 * multi-candidate type behaves like `memory` — and must NOT special-case the
 * literal `.derived` suffix or `assetType === "memory"` themselves; this is
 * the one place that knowledge lives.
 */
export function assetPathCandidatesAreOrderedByPreference(assetType: string): boolean {
  return assetType === "memory";
}
