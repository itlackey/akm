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
import { SCRIPT_EXTENSIONS, WORKFLOW_EXTENSIONS } from "../recognition-util";

function toPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

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
    // Strip .md extension from canonical names (agent:code-reviewer, not agent:code-reviewer.md)
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

const PLACEMENT_SPECS: Record<string, AssetSpec> = {
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
      return rel.endsWith(".yml") ? rel.slice(0, -4) : rel;
    },
    toAssetPath: (typeRoot: string, name: string) => {
      const withExt = name.endsWith(".yml") ? name : `${name}.yml`;
      return path.join(typeRoot, withExt);
    },
  },
  // #561 — agent sessions indexed as a first-class searchable asset type.
  // Generated markdown written by the `extract` pass to
  // `sessions/<harness>/<session-id>.md`.
  session: { stashDir: "sessions", ...markdownSpec },
  // Durable stash-level semantic knowledge — facts about the user, team, or
  // project. A plain markdown spec; see docs/design/fact-asset-type.md.
  fact: { stashDir: "facts", ...markdownSpec },
};

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
  const typeRoot = firstSegment === stashDirFor(assetType) ? path.join(stashRoot, firstSegment) : stashRoot;
  return deriveCanonicalAssetName(assetType, typeRoot, filePath);
}

export function assetPathForName(assetType: string, typeRoot: string, name: string): string {
  const spec = PLACEMENT_SPECS[assetType];
  if (!spec) throw new Error(`Unknown asset type: "${assetType}"`);
  return spec.toAssetPath(typeRoot, name);
}
