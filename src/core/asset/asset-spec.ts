// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { buildWorkflowAction } from "../../output/renderers";
import { registerActionBuilder, registerTypeRenderer } from "./asset-registry";

function toPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

const buildTaskAction = (ref: string): string =>
  `akm tasks show ${ref.replace(/^task:/, "")} -> inspect; akm tasks run <id> -> run now; akm tasks remove <id> -> unschedule`;

export interface AssetSpec {
  stashDir: string;
  isRelevantFile: (fileName: string) => boolean;
  toCanonicalName: (typeRoot: string, filePath: string) => string | undefined;
  toAssetPath: (typeRoot: string, name: string) => string;
  /**
   * Optional renderer name to use for this asset type in search results and show.
   * If provided, calling `registerAssetType` will automatically populate
   * `TYPE_TO_RENDERER` in the asset-registry singleton.
   */
  rendererName?: string;
  /**
   * Optional action builder for this asset type in search results.
   * If provided, calling `registerAssetType` will automatically populate
   * `ACTION_BUILDERS` in the asset-registry singleton.
   */
  actionBuilder?: (ref: string) => string;
}

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

/** All recognized script extensions for the script asset type */
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
  workflow: {
    stashDir: "workflows",
    ...markdownSpec,
    rendererName: "workflow-md",
    actionBuilder: (ref) => buildWorkflowAction(ref),
  },
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
    rendererName: "env-file",
    actionBuilder: (ref) =>
      `akm show ${ref} -> inspect key names; akm env run ${ref} -- <command> -> run with the whole .env injected (prefer --clean to minimize inherited parent env; child stdout is not redacted); akm env export ${ref} --out <file> -> write a sourceable script to a file`,
  },
  // Secrets — a single sensitive value used on its own for authentication (a
  // PEM key, API token, TLS cert). Unlike `env` (a group of related .env
  // configuration), the ENTIRE file is the one secret value — there is no safe
  // region to parse, so only the filename is ever surfaced as metadata. The
  // value reaches a command only via `akm secret run` (injected into a child
  // env var) or `akm secret path` (Docker `_FILE` convention). A secret is any
  // regular file under `secrets/` except `.lock`/`.sensitive` sidecars; the
  // canonical name preserves the natural filename (e.g. `id_rsa`, `team/deploy.key`).
  secret: {
    stashDir: "secrets",
    isRelevantFile: (fileName) => !fileName.endsWith(".lock") && !fileName.endsWith(".sensitive"),
    toCanonicalName: (typeRoot, filePath) => toPosix(path.relative(typeRoot, filePath)),
    toAssetPath: (typeRoot, name) => path.join(typeRoot, name),
    rendererName: "secret-file",
    actionBuilder: (ref) =>
      `akm show ${ref} -> name only (value never shown); akm secret path ${ref} -> file path; akm secret run ${ref} <VAR> -- <command> -> run with value injected into $VAR`,
  },
  wiki: {
    stashDir: "wikis",
    ...markdownSpec,
    rendererName: "wiki-md",
    actionBuilder: (ref) => `akm show ${ref} -> read the wiki page`,
  },
  // v1 spec §13 — `lesson` asset type. Required frontmatter fields are
  // `description` and `when_to_use`; lint enforces both (see
  // `src/core/lesson-lint.ts`). Lessons normally arrive as proposals via
  // `akm distill <ref>` (§14.5) and are promoted via `akm proposal accept`,
  // but they can also be authored directly with `akm import` /
  // `akm remember`-style flows.
  lesson: {
    stashDir: "lessons",
    ...markdownSpec,
    rendererName: "lesson-md",
    actionBuilder: (ref) => `akm show ${ref} -> read the lesson and apply when_to_use`,
  },
  // Scheduled tasks. A task file pairs a cron-style schedule with a target
  // (workflow ref, prompt, or command) that `akm tasks` registers with the
  // OS-native scheduler (cron / launchd / schtasks). Stored as pure YAML
  // under <stash>/tasks/<id>.yml.
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
    rendererName: "task-yaml",
    actionBuilder: buildTaskAction,
  },
  // #561 — agent sessions indexed as a first-class searchable asset type.
  // Generated (derived) markdown written by the `extract` pass to
  // `sessions/<harness>/<session-id>.md`; carries `log_path` + `access`
  // frontmatter so any agent can navigate into the raw session log. A plain
  // markdown spec — the summary body is the searchable surface.
  session: {
    stashDir: "sessions",
    ...markdownSpec,
    rendererName: "session-md",
    actionBuilder: (ref) =>
      `akm show ${ref} -> read the session summary; follow the \`access\` frontmatter to open the raw log at \`log_path\``,
  },
  // Durable stash-level semantic knowledge — facts about the user, team, or
  // project (personal details, team tool stacks, coding conventions /
  // "constitution", and stash-meta like naming conventions or the active
  // projects list). Unlike `memory` (episodic, recency-decayed) these are
  // mostly-static declarations meant to be reliably surfaced as context. A
  // plain markdown spec; `category` frontmatter scopes the fact and
  // `pinned: true` marks the small always-injected core. See
  // docs/design/fact-asset-type.md.
  fact: {
    stashDir: "facts",
    ...markdownSpec,
    rendererName: "fact-md",
    actionBuilder: (ref) => `akm show ${ref} -> read the stash fact and apply it as durable context`,
  },
};

export const ASSET_SPECS: Record<string, AssetSpec> = ASSET_SPECS_INTERNAL;

/**
 * Register a custom asset type with the akm asset system.
 *
 * ## Full extension registration API
 *
 * Providing `rendererName` and/or `actionBuilder` in the spec automatically
 * registers the renderer and action builder so that search results and `show`
 * output work out of the box without additional calls.
 *
 * ### Minimal registration (filesystem layout only)
 * ```ts
 * registerAssetType("widget", {
 *   stashDir: "widgets",
 *   isRelevantFile: (f) => f.endsWith(".widget"),
 *   toCanonicalName: (root, fp) => path.basename(fp, ".widget"),
 *   toAssetPath: (root, name) => path.join(root, `${name}.widget`),
 * });
 * ```
 *
 * ### Full registration (filesystem + renderer + action)
 * ```ts
 * registerAssetType("widget", {
 *   stashDir: "widgets",
 *   isRelevantFile: (f) => f.endsWith(".widget"),
 *   toCanonicalName: (root, fp) => path.basename(fp, ".widget"),
 *   toAssetPath: (root, name) => path.join(root, `${name}.widget`),
 *   rendererName: "widget-md",        // registered via registerRenderer() separately
 *   actionBuilder: (ref) => `akm show ${ref} -> use widget`,
 * });
 * ```
 *
 * Renderer and action builder registration is handled directly via the
 * `asset-registry` singleton — no deferred hooks or import-order concerns.
 */
export function registerAssetType(type: string, spec: AssetSpec): void {
  ASSET_SPECS_INTERNAL[type] = spec;
  TYPE_DIRS[type] = spec.stashDir;

  // Auto-register renderer and action builder if provided in spec
  if (spec.rendererName) {
    registerTypeRenderer(type, spec.rendererName);
  }
  if (spec.actionBuilder) {
    registerActionBuilder(type, spec.actionBuilder);
  }
}

/**
 * Remove a previously-registered asset type.
 *
 * Primarily used by tests for cleanup after `registerAssetType` calls so
 * subsequent tests see a pristine type registry. Built-in types should not
 * normally be deregistered at runtime.
 */
export function deregisterAssetType(type: string): void {
  delete ASSET_SPECS_INTERNAL[type];
  delete TYPE_DIRS[type];
}

export function getAssetTypes(): readonly string[] {
  return Object.keys(ASSET_SPECS_INTERNAL);
}

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
