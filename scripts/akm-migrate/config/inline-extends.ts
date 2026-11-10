// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `extends` (config inheritance, 0.9.15 to 0.10.261019) is retired: the CLI refuses a file that still has it, and
 * `akm migrate apply` merges the base into the file once and drops the key. This is the chain resolver, moved out of
 * the CLI. It goes with the rest of the migrator at 0.11.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBundleSlug } from "../../../src/core/asset/asset-ref";
import { isRecord } from "../../../src/core/common";
import { readConfigText } from "../../../src/core/config/config-io";
import { bundleComponentConfig, bundleContentRoot } from "../../../src/core/config/config-sources";
import type { BundleConfigEntry } from "../../../src/core/config/config-types";
import { deepMergeConfig, isPlainObject } from "../../../src/core/config/deep-merge";
import { ConfigError } from "../../../src/core/errors";

type Dict = Record<string, unknown>;

/** One layer of the chain, local file first: the `extends` value that led to it (none for the file itself) and its document. */
interface Layer {
  readonly ref: string | undefined;
  readonly document: Dict;
}

/** What the base chain was merged into the file, and what the merge left out. */
export interface InlinedExtends {
  /** The file's document with every base merged under it and `extends` removed. */
  readonly document: Dict;
  readonly notes: readonly string[];
}

/**
 * Merge the `extends` chain of `document` (read from `configPath`) into it. A base is a file path (relative to the file
 * that names it; `~` expands) or a `bundle//<path>` ref naming a file under a filesystem bundle's content root. Each
 * layer's own fields win over its base's, as the runtime merged them. What the runtime never took from a base stays out:
 * host-local keys, a connection's `apiKey`, a harness's `bin`/`args`/`workspace`, a strategy's `sync`.
 * A document without `extends` comes back as it is. A cycle or a base that cannot be read throws.
 */
export function inlineExtends(
  document: Dict,
  configPath: string,
  readDocument: (text: string, sourcePath: string) => Dict,
): InlinedExtends {
  if (document.extends === undefined) return { document, notes: [] };
  const notes: string[] = [];
  const layers = collectLayers(document, configPath, readDocument);
  let merged: Dict = {};
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i] as Layer;
    const own = layer.ref === undefined ? layer.document : portable(layer.document, layer.ref, notes);
    const inherited = merged.projects;
    merged = deepMergeConfig(merged, own);
    // A project is replaced whole by name: its fields are never merged across layers.
    if (isPlainObject(inherited) && isPlainObject(own.projects)) merged.projects = { ...inherited, ...own.projects };
  }
  delete merged.extends;
  notes.push(
    `extends ${JSON.stringify(document.extends)}: ${layers.length - 1} base ${layers.length === 2 ? "config" : "configs"} merged into this file; the key is removed.`,
  );
  return { document: merged, notes };
}

function collectLayers(
  document: Dict,
  configPath: string,
  readDocument: (text: string, sourcePath: string) => Dict,
): Layer[] {
  const layers: Layer[] = [{ ref: undefined, document }];
  const visited = new Set([path.resolve(configPath)]);
  let current = document;
  let currentPath = configPath;
  let containmentRoot: string | undefined;
  while (current.extends !== undefined) {
    const ref = current.extends;
    if (typeof ref !== "string" || !ref.trim()) {
      throw new ConfigError(
        `Invalid "extends" at ${currentPath}: expected a non-empty string (a file path or bundle//path ref), got ${JSON.stringify(ref)}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const found = locate(ref, current, currentPath, containmentRoot);
    if (visited.has(found.resolvedPath)) {
      throw new ConfigError(
        `Config "extends" cycle: "${ref}" (from ${currentPath}) resolves back to ${found.resolvedPath}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    visited.add(found.resolvedPath);
    current = readDocument(found.text, found.resolvedPath);
    currentPath = found.resolvedPath;
    containmentRoot = found.containmentRoot;
    layers.push({ ref, document: current });
  }
  return layers;
}

const HOST_LOCAL_KEYS = ["bundles", "defaultBundle", "embedding", "experimental", "registries", "scheduler"] as const;

/** A base's document as the runtime took it: portable settings only. Each thing left out is noted. */
function portable(base: Dict, label: string, notes: string[]): Dict {
  const out: Dict = { ...base };
  const left = HOST_LOCAL_KEYS.filter((key) => Object.hasOwn(out, key));
  for (const key of left) delete out[key];
  if (left.length > 0) notes.push(`extends ${JSON.stringify(label)}: ${left.join(", ")} not merged; they are host-local.`);

  let strippedAuthority = false;
  for (const section of ["connections", "harnesses"] as const) {
    const entries = out[section];
    if (!isPlainObject(entries)) continue;
    out[section] = Object.fromEntries(
      Object.entries(entries).map(([name, entry]) => {
        if (!isPlainObject(entry)) return [name, entry];
        const kept = { ...entry };
        for (const key of ["apiKey", "bin", "args", "workspace"]) {
          if (!Object.hasOwn(kept, key)) continue;
          delete kept[key];
          strippedAuthority = true;
        }
        return [name, kept];
      }),
    );
  }
  if (strippedAuthority) {
    notes.push(
      `extends ${JSON.stringify(label)}: connection credentials, harness bin, args and workspace not merged; they are host-local.`,
    );
  }

  const improve = out.improve;
  if (isPlainObject(improve) && isPlainObject(improve.strategies)) {
    let strippedSync = false;
    const strategies = Object.fromEntries(
      Object.entries(improve.strategies).map(([name, profile]) => {
        if (!isPlainObject(profile) || !Object.hasOwn(profile, "sync")) return [name, profile];
        strippedSync = true;
        const { sync: _sync, ...rest } = profile;
        return [name, rest];
      }),
    );
    out.improve = { ...improve, strategies };
    if (strippedSync) {
      notes.push(`extends ${JSON.stringify(label)}: improve strategy sync policy not merged; it is host-local.`);
    }
  }
  return out;
}

interface Located {
  readonly text: string;
  readonly resolvedPath: string;
  readonly containmentRoot?: string;
}

function locate(ref: string, context: Dict, fromPath: string, containmentRoot: string | undefined): Located {
  const boundary = ref.indexOf("//");
  if (boundary > 0 && isBundleSlug(ref.slice(0, boundary))) return locateInBundle(ref, boundary, context, containmentRoot);
  const expanded = ref.startsWith("~") ? path.join(os.homedir(), ref.slice(1)) : ref;
  const resolvedPath = path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(fromPath), expanded);
  if (containmentRoot !== undefined) assertContained(containmentRoot, resolvedPath, ref);
  return { text: readBase(ref, resolvedPath), resolvedPath, ...(containmentRoot ? { containmentRoot } : {}) };
}

function locateInBundle(ref: string, boundary: number, context: Dict, outerRoot: string | undefined): Located {
  const bundleId = ref.slice(0, boundary);
  const relativePath = ref.slice(boundary + 2);
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new ConfigError(
      `extends "${ref}" needs a path relative to bundle "${bundleId}"'s content root after "//".`,
      "INVALID_CONFIG_FILE",
    );
  }
  const entry = isRecord(context.bundles) ? context.bundles[bundleId] : undefined;
  if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.length === 0) {
    throw new ConfigError(
      `extends "${ref}" names bundle "${bundleId}", which is not a configured filesystem bundle (bundles.${bundleId}.path).`,
      "INVALID_CONFIG_FILE",
    );
  }
  const root = bundleContentRoot(entry.path, bundleComponentConfig(entry as BundleConfigEntry)?.root);
  const resolvedPath = path.resolve(root, relativePath);
  const fromRoot = path.relative(root, resolvedPath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new ConfigError(`extends "${ref}" escapes bundle "${bundleId}"'s content root.`, "INVALID_CONFIG_FILE");
  }
  const bundleRoot = fs.existsSync(root) ? fs.realpathSync.native(root) : root;
  if (fs.existsSync(resolvedPath)) {
    assertContained(bundleRoot, resolvedPath, ref);
    if (outerRoot !== undefined) assertContained(outerRoot, resolvedPath, ref);
  }
  return { text: readBase(ref, resolvedPath), resolvedPath, containmentRoot: outerRoot ?? bundleRoot };
}

/** A base that is a symbolic link out of its bundle is refused, as the runtime refused it. */
function assertContained(root: string, candidate: string, ref: string): void {
  if (!fs.existsSync(candidate)) return;
  const relative = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConfigError(
      `extends ${JSON.stringify(ref)} resolves through a symbolic link outside its bundle content root.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

function readBase(ref: string, resolvedPath: string): string {
  const text = readConfigText(resolvedPath);
  if (text === undefined) {
    throw new ConfigError(
      `extends "${ref}" resolves to ${resolvedPath}, which does not exist, so its settings cannot be merged. Restore the file, or remove "extends" from the config, then run \`akm migrate apply\` again.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return text;
}
