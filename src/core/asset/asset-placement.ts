// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure recognition/placement layer for the built-in akm asset types — akm
 * 0.9.0 chunk-3 (the taxonomy-cutover leaf).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the `AssetSpec` filesystem
 * surface (`stashDir`/`isRelevantFile`/`toCanonicalName`/`toAssetPath`), the
 * `TYPE_DIRS` stash-subdir map, and the derive/resolve helpers built on them.
 * It was extracted VERBATIM from `asset-spec.ts` so the `akm` bundle adapter
 * (`adapter/adapters/akm-adapter.ts`) can consume placement WITHOUT importing
 * `asset-spec.ts` — which pulls in `output/renderers` + `asset-registry` and is
 * therefore a taxonomy import-cycle (SCC) participant. Depending on that leaf
 * from the adapter would drag the adapter into the SCC and block the chunk-3
 * cutover; depending on THIS leaf does not (it imports only Node builtins and
 * the `core/recognition-util` leaf).
 *
 * ── Why `rendererName`/`actionBuilder` are absent from the built-in specs ──
 *
 * The built-in per-type renderer names and action builders live in the STATIC
 * `TYPE_TO_RENDERER`/`ACTION_BUILDERS` maps in `asset-registry.ts` (and, for
 * recognition, `type-presentation.ts`). The `rendererName`/`actionBuilder`
 * fields on the live `ASSET_SPECS` were ONLY read by `registerAssetType`'s
 * auto-registration path for CUSTOM types (built-ins bypass it), so dropping
 * them here is behavior-preserving — proven by the frozen migrator copy
 * (`migrate/legacy/legacy-layout.ts`, which drops them identically) and its
 * faithfulness test. The optional fields remain on the {@link AssetSpec}
 * interface because `registerAssetType` still reads them off a caller-supplied
 * custom spec (that wiring stays in `asset-spec.ts`, which keeps the
 * asset-registry edge).
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
  /**
   * Optional renderer name to use for this asset type in search results and show.
   * If provided, calling `registerAssetType` will automatically populate
   * `TYPE_TO_RENDERER` in the asset-registry singleton. Absent on the built-in
   * specs below — see the module header.
   */
  rendererName?: string;
  /**
   * Optional action builder for this asset type in search results.
   * If provided, calling `registerAssetType` will automatically populate
   * `ACTION_BUILDERS` in the asset-registry singleton. Absent on the built-in
   * specs below — see the module header.
   */
  actionBuilder?: (ref: string) => string;
}

const workflowSpec: Omit<AssetSpec, "stashDir" | "rendererName" | "actionBuilder"> = {
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

const ASSET_SPECS_INTERNAL: Record<string, AssetSpec> = {
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
  wiki: { stashDir: "wikis", ...markdownSpec },
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

export const ASSET_SPECS: Record<string, AssetSpec> = ASSET_SPECS_INTERNAL;

export const TYPE_DIRS: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_SPECS_INTERNAL).map(([type, spec]) => [type, spec.stashDir]),
);

/**
 * Mutate the placement registry to add/replace a type's spec. Called only by
 * `asset-spec.ts#registerAssetType` (which additionally wires the renderer/
 * action into the asset-registry singleton). Keeps `TYPE_DIRS` in sync.
 */
export function registerAssetSpec(type: string, spec: AssetSpec): void {
  ASSET_SPECS_INTERNAL[type] = spec;
  TYPE_DIRS[type] = spec.stashDir;
}

/** Remove a previously-registered type's spec. Called by `asset-spec.ts#deregisterAssetType`. */
export function deregisterAssetSpec(type: string): void {
  delete ASSET_SPECS_INTERNAL[type];
  delete TYPE_DIRS[type];
}

export function getAssetTypes(): readonly string[] {
  return Object.keys(ASSET_SPECS_INTERNAL);
}

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
  // When the first segment matches the canonical type dir (e.g. "agents"),
  // use it as the type root so canonical names are relative to it.
  // Otherwise fall back to stashRoot — this preserves the full relative path
  // as the canonical name, which is correct for installed stashes that live
  // under custom directories (e.g. "tools/agents/svelte-file-editor").
  const typeRoot = firstSegment === TYPE_DIRS[assetType] ? path.join(stashRoot, firstSegment) : stashRoot;
  return deriveCanonicalAssetName(assetType, typeRoot, filePath);
}

export function resolveAssetPathFromName(assetType: string, typeRoot: string, name: string): string {
  const spec = ASSET_SPECS[assetType];
  if (!spec) throw new Error(`Unknown asset type: "${assetType}"`);
  return spec.toAssetPath(typeRoot, name);
}
