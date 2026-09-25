#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-config-schema-compat.ts
 *
 * Catches a config-schema regression at review time instead of at the next
 * outage: `ExperimentalConfigSchema` went `.strict()` in 0.9.16 with no
 * record of which keys earlier releases accepted under it, and the retired
 * `experimental.workflowEngine` then failed every command for anyone whose
 * 0.9.15-written config still carried it (see `src/core/config/retired-keys.ts`).
 *
 * Compares `schemas/akm-config.json` at HEAD against the same file at the
 * highest stable (`vX.Y.Z`, no prerelease suffix) `v*` tag below
 * `package.json`'s version, and reports:
 *   (a) every property path present in the previous schema and absent from
 *       the current one that is not registered in
 *       `RETIRED_CONFIG_KEYS` (`src/core/config/retired-keys.ts`); and
 *   (b) every object whose `additionalProperties` tightened from
 *       absent/true to `false` that is not registered in
 *       `STRICTENED_CONFIG_OBJECTS` (same file).
 *
 * `findSchemaRegressions` is the pure comparison (no filesystem, no git) —
 * `tests/lint-config-schema-compat.test.ts` exercises it directly with
 * synthetic schemas.
 *
 * Per AGENTS.md #795 ("never pass inconclusively"): when no reachable
 * previous stable tag exists (e.g. a shallow checkout with `git fetch --tags`
 * never run), this FAILS rather than skipping.
 *
 * Usage:
 *   bun scripts/lint-config-schema-compat.ts
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { RETIRED_CONFIG_KEYS, STRICTENED_CONFIG_OBJECTS } from "../src/core/config/retired-keys";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCHEMA_RELATIVE_PATH = "schemas/akm-config.json";

// ── Pure schema comparison ──────────────────────────────────────────────────

export interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
  [key: string]: unknown;
}

interface WalkedSchema {
  /** Every dotted property path reachable from the root, e.g. `"scheduler.enabled"`. */
  propertyPaths: Set<string>;
  /** For every object node with a `properties` map: its path -> `additionalProperties === false`. */
  strictObjects: Map<string, boolean>;
}

/**
 * Walk a JSON Schema tree from its root, collecting every named property
 * path and every object's strictness. `$ref` (`"#/$defs/Name"`) is resolved
 * against the schema's own `$defs` and walked IN PLACE at the referencing
 * path — a type moved into `$defs` and referenced by `$ref` therefore
 * produces the same paths as when it was inline, not a false "removed"/
 * "added" diff. `anyOf`/`allOf` arms are walked at the same path as their
 * parent (alternate shapes of the same field). A dictionary-typed object
 * (`additionalProperties` holding a schema rather than a boolean — akm's
 * `engines`/`bundles` maps) has its value schema walked at `path + "[]"`,
 * the same convention used for array `items`.
 */
function walkSchema(root: JsonSchemaNode): WalkedSchema {
  const propertyPaths = new Set<string>();
  const strictObjects = new Map<string, boolean>();
  const defs = root.$defs ?? {};

  function visit(node: JsonSchemaNode | undefined, at: string, refChain: ReadonlySet<string>): void {
    if (!node || typeof node !== "object") return;

    if (typeof node.$ref === "string") {
      const name = node.$ref.replace(/^#\/\$defs\//, "");
      if (refChain.has(name)) return; // cycle guard
      const target = defs[name];
      if (!target) return;
      visit(target, at, new Set(refChain).add(name));
      return;
    }

    if (node.properties && typeof node.properties === "object") {
      strictObjects.set(at, node.additionalProperties === false);
      for (const [key, child] of Object.entries(node.properties)) {
        const childPath = at ? `${at}.${key}` : key;
        propertyPaths.add(childPath);
        visit(child, childPath, refChain);
      }
    } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
      visit(node.additionalProperties, `${at}[]`, refChain);
    }

    if (node.items) visit(node.items, `${at}[]`, refChain);
    if (Array.isArray(node.anyOf)) for (const arm of node.anyOf) visit(arm, at, refChain);
    if (Array.isArray(node.allOf)) for (const arm of node.allOf) visit(arm, at, refChain);
  }

  visit(root, "", new Set());
  return { propertyPaths, strictObjects };
}

export interface RemovedPropertyRegression {
  kind: "removed-property";
  path: string;
}

export interface StrictenedObjectRegression {
  kind: "strictened-object";
  path: string;
}

export type SchemaRegression = RemovedPropertyRegression | StrictenedObjectRegression;

export interface SchemaCompatRegistry {
  retiredKeys: readonly { path: string }[];
  strictenedObjects: readonly { path: string }[];
}

/**
 * Pure core: diff two parsed JSON Schema documents against the retired-keys
 * registry. No filesystem or process access — see the module doc for what
 * each regression kind means.
 */
export function findSchemaRegressions(
  previous: JsonSchemaNode,
  current: JsonSchemaNode,
  registry: SchemaCompatRegistry,
): SchemaRegression[] {
  const before = walkSchema(previous);
  const after = walkSchema(current);

  const registeredRetired = new Set(registry.retiredKeys.map((entry) => entry.path));
  const registeredStrict = new Set(registry.strictenedObjects.map((entry) => entry.path));

  const regressions: SchemaRegression[] = [];

  for (const removedPath of before.propertyPaths) {
    if (after.propertyPaths.has(removedPath)) continue;
    if (registeredRetired.has(removedPath)) continue;
    regressions.push({ kind: "removed-property", path: removedPath });
  }

  for (const [objectPath, isStrictNow] of after.strictObjects) {
    if (!isStrictNow) continue;
    if (!before.strictObjects.has(objectPath)) continue; // a brand-new object never had an open shape to regress from
    if (before.strictObjects.get(objectPath) === true) continue; // already strict before — not a new regression
    if (registeredStrict.has(objectPath)) continue;
    regressions.push({ kind: "strictened-object", path: objectPath });
  }

  regressions.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return regressions;
}

function formatRegression(r: SchemaRegression): string {
  if (r.kind === "removed-property") {
    return (
      `  - ${r.path}: present in the previous schema, absent now, and not registered in ` +
      "RETIRED_CONFIG_KEYS (src/core/config/retired-keys.ts). If this removal is intentional, " +
      'register it there (disposition "ignored" or "lifted") and make the config-load shim drop ' +
      "or lift it; a reader must still tolerate what an older release wrote."
    );
  }
  return (
    `  - ${r.path}: additionalProperties tightened to false and not registered in ` +
    "STRICTENED_CONFIG_OBJECTS (src/core/config/retired-keys.ts). If this strictening is " +
    "intentional, register it there and make sure the shim drops any retired member key first."
  );
}

// ── Git/tag wiring ───────────────────────────────────────────────────────────

function runGit(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * The highest stable (`vX.Y.Z`, no prerelease suffix) `v*` tag whose version
 * sorts below `currentVersion`. Throws — never returns nothing — when no
 * tag qualifies, per AGENTS.md #795: a gate that cannot run must fail with
 * the fix, not pass inconclusively.
 */
export function resolvePreviousStableTag(currentVersion: string, tags: readonly string[]): string {
  const stable = tags
    .map((tag) => ({ tag, version: tag.replace(/^v/, "") }))
    .filter(({ version }) => semver.valid(version) !== null && semver.prerelease(version) === null)
    .filter(({ version }) => semver.lt(version, currentVersion));

  if (stable.length === 0) {
    throw new Error(
      "lint-config-schema-compat: no reachable stable v* tag below package.json's version " +
        `(${currentVersion}). Fetch tags: git fetch --tags`,
    );
  }

  stable.sort((a, b) => semver.compare(a.version, b.version));
  const highest = stable.at(-1);
  if (!highest) {
    throw new Error("lint-config-schema-compat: internal error resolving the previous stable tag");
  }
  return highest.tag;
}

function readPackageVersion(): string {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  const version = (JSON.parse(raw) as { version?: string }).version;
  if (!version) throw new Error("lint-config-schema-compat: package.json has no version field");
  return version;
}

function readPreviousSchema(tag: string): JsonSchemaNode {
  const result = runGit(["show", `${tag}:${SCHEMA_RELATIVE_PATH}`]);
  if (result.status !== 0) {
    throw new Error(
      `lint-config-schema-compat: could not read ${SCHEMA_RELATIVE_PATH} at ${tag} ` +
        `(git show exited ${result.status}): ${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout) as JsonSchemaNode;
}

function readCurrentSchema(): JsonSchemaNode {
  const target = path.join(REPO_ROOT, SCHEMA_RELATIVE_PATH);
  if (!fs.existsSync(target)) {
    throw new Error(
      `lint-config-schema-compat: ${SCHEMA_RELATIVE_PATH} is missing. Run \`bun scripts/gen-config-schema.ts\`.`,
    );
  }
  return JSON.parse(fs.readFileSync(target, "utf8")) as JsonSchemaNode;
}

function listStableTags(): string[] {
  const result = runGit(["tag", "--list", "v*"]);
  if (result.status !== 0) {
    throw new Error(`lint-config-schema-compat: \`git tag --list 'v*'\` failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main(): void {
  const currentVersion = readPackageVersion();
  const previousTag = resolvePreviousStableTag(currentVersion, listStableTags());
  const previousSchema = readPreviousSchema(previousTag);
  const currentSchema = readCurrentSchema();

  const regressions = findSchemaRegressions(previousSchema, currentSchema, {
    retiredKeys: RETIRED_CONFIG_KEYS,
    strictenedObjects: STRICTENED_CONFIG_OBJECTS,
  });

  if (regressions.length > 0) {
    console.error(
      `lint-config-schema-compat: ${regressions.length} unregistered schema regression(s) between ` +
        `${previousTag} and HEAD:`,
    );
    for (const regression of regressions) console.error(formatRegression(regression));
    process.exit(1);
  }

  console.log(
    `lint-config-schema-compat: OK - schemas/akm-config.json vs ${previousTag} has no unregistered regressions.`,
  );
}

if (import.meta.main) {
  main();
}
