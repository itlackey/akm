// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * One-time rewrite of persisted 0.8 task `workflow:` targets. This module is
 * migrator-only: live task parsing remains strict 0.9 grammar. Planning parses
 * and resolves every legacy v1 target before `migrate apply` mutates core
 * artifacts; application then replaces only the YAML scalar bytes and uses an
 * atomic write. The apply coordinator journals the batch as a forward-recovery
 * phase, so an interrupted partial batch is safely re-planned and resumed.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { bundlesToSourceEntries } from "../../core/config/config";
import type { AkmConfig, BundleConfigEntry } from "../../core/config/config-types";
import { ConfigError } from "../../core/errors";
import { resolveWritable } from "../../core/write-source";
import { resolveEntryContentDir } from "../../indexer/search/search-source";
import { classifyRefGrammar, legacyConceptId, parseAssetRef } from "../legacy-ref-grammar";
import {
  canonicalizeWorkflowName,
  type LegacySource,
  resolveAssetPathFromName,
  resolveSourcesForOrigin,
} from "./legacy-layout";

interface MigrationBundle {
  id: string;
  root: string;
  registryId?: string;
  primary: boolean;
  writable: boolean;
}

export interface TaskTargetRefRewrite {
  filePath: string;
  from: string;
  to: string;
  before: Buffer;
  after: Buffer;
  mode: number;
}

export interface TaskTargetRefMigrationPlan {
  rewrites: TaskTargetRefRewrite[];
  durabilityPaths: string[];
}

function migrationError(filePath: string, detail: string): ConfigError {
  return new ConfigError(
    `Cannot migrate persisted task target in ${filePath}: ${detail} ` +
      "Repair or remove this task, then rerun `akm migrate apply`.",
    "INVALID_CONFIG_FILE",
  );
}

function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function bundlesFromConfig(config: AkmConfig): MigrationBundle[] {
  const entries = Object.entries(config.bundles ?? {});
  const sourceEntries = new Map((bundlesToSourceEntries(config) ?? []).map((entry) => [entry.name, entry]));
  const defaultId = config.defaultBundle;
  const ordered = defaultId
    ? [...entries.filter(([id]) => id === defaultId), ...entries.filter(([id]) => id !== defaultId)]
    : entries;
  const bundles: MigrationBundle[] = [];
  const roots = new Map<string, string>();
  for (const [id, rawEntry] of ordered) {
    const entry = rawEntry as BundleConfigEntry;
    const sourceEntry = sourceEntries.get(id);
    if (!sourceEntry) continue;
    const contentDir = resolveEntryContentDir(sourceEntry);
    if (!contentDir) continue;
    const root = path.resolve(expandTilde(contentDir));
    const rootIdentity = fs.existsSync(root) ? fs.realpathSync(root) : root;
    const prior = roots.get(rootIdentity);
    if (prior && prior !== id) {
      throw new ConfigError(
        `Cannot migrate persisted task targets because bundles "${prior}" and "${id}" resolve to the same root ${root}. ` +
          "Give each bundle a distinct path, then rerun `akm migrate apply`.",
        "INVALID_CONFIG_FILE",
      );
    }
    roots.set(rootIdentity, id);
    bundles.push({
      id,
      root,
      ...(typeof entry.registryId === "string" && entry.registryId.length > 0 ? { registryId: entry.registryId } : {}),
      primary: id === defaultId,
      writable: resolveWritable(sourceEntry),
    });
  }
  return bundles;
}

function resolveOrigin(origin: string, bundles: MigrationBundle[], filePath: string): MigrationBundle {
  if (origin === "local" || origin === "stash") {
    const primary = bundles.find((bundle) => bundle.primary);
    if (primary) return primary;
    throw migrationError(filePath, `legacy origin "${origin}" has no configured default bundle.`);
  }

  let candidates = bundles.filter((bundle) => bundle.id === origin || bundle.registryId === origin);
  if (candidates.length === 0) {
    const sources: LegacySource[] = bundles.map((bundle) => ({
      path: bundle.root,
      registryId: bundle.registryId ?? bundle.id,
    }));
    const resolved = resolveSourcesForOrigin(origin, sources);
    candidates = resolved
      .map((source) => bundles[sources.indexOf(source)])
      .filter((bundle): bundle is MigrationBundle => bundle !== undefined);
  }
  if (candidates.length === 0) {
    throw migrationError(filePath, `legacy workflow origin "${origin}" does not resolve to a configured bundle.`);
  }
  if (candidates.length > 1) {
    throw migrationError(
      filePath,
      `legacy workflow origin "${origin}" is ambiguous across bundles ${candidates.map((bundle) => `"${bundle.id}"`).join(", ")}.`,
    );
  }
  const candidate = candidates[0];
  if (!candidate) throw migrationError(filePath, `legacy workflow origin "${origin}" did not resolve.`);
  return candidate;
}

function assertWorkflowExists(bundle: MigrationBundle, name: string, rawRef: string, filePath: string): void {
  const candidate = resolveAssetPathFromName("workflow", path.join(bundle.root, "workflows"), name);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw migrationError(
      filePath,
      `legacy target "${rawRef}" was not found in bundle "${bundle.id}" at ${bundle.root}.`,
    );
  }
  const realRoot = fs.realpathSync(bundle.root);
  const realCandidate = fs.realpathSync(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw migrationError(filePath, `legacy target "${rawRef}" resolves outside bundle "${bundle.id}".`);
  }
}

function assertRealPathWithin(root: string, candidate: string, filePath: string, detail: string): void {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw migrationError(filePath, detail);
}

function renderScalarLike(sourceToken: string, replacement: string, filePath: string): string {
  if (sourceToken.startsWith("'") && sourceToken.endsWith("'")) {
    return `'${replacement.replaceAll("'", "''")}'`;
  }
  if (sourceToken.startsWith('"') && sourceToken.endsWith('"')) return JSON.stringify(replacement);
  if (/^[^\s#[\]{},&*!|>'"%@`]+$/.test(sourceToken)) return replacement;
  throw migrationError(filePath, "the legacy workflow target uses an unsupported YAML scalar style.");
}

function planTaskFile(
  filePath: string,
  containing: MigrationBundle,
  bundles: MigrationBundle[],
  durabilityPaths: string[],
): TaskTargetRefRewrite | undefined {
  const before = fs.readFileSync(filePath);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before);
  } catch {
    throw migrationError(filePath, "task YAML contains invalid UTF-8 bytes.");
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  const yamlError = doc.errors[0];
  if (yamlError) throw migrationError(filePath, `invalid YAML (${yamlError.message}).`);
  if (!isMap(doc.contents)) throw migrationError(filePath, "task YAML must be a mapping.");
  const version = doc.get("version");
  if (version !== undefined && version !== 1) return undefined;
  if (!doc.has("workflow")) return undefined;
  const node = doc.get("workflow", true);
  if (!isScalar(node) || typeof node.value !== "string") {
    throw migrationError(filePath, "legacy `workflow` must be a string scalar.");
  }
  const from = node.value.trim();
  if (classifyRefGrammar(from) !== "legacy") {
    durabilityPaths.push(filePath);
    return undefined;
  }

  let parsed: ReturnType<typeof parseAssetRef>;
  try {
    parsed = parseAssetRef(from);
  } catch (error) {
    throw migrationError(
      filePath,
      `legacy workflow target "${from}" is invalid (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (parsed.type !== "workflow") {
    throw migrationError(filePath, `legacy target "${from}" has type "${parsed.type}", not "workflow".`);
  }
  const name = canonicalizeWorkflowName(parsed.name);
  const targetBundle = parsed.origin ? resolveOrigin(parsed.origin, bundles, filePath) : containing;
  assertWorkflowExists(targetBundle, name, from, filePath);
  const conceptId = legacyConceptId("workflow", name);
  const to = parsed.origin ? `${targetBundle.id}//${conceptId}` : conceptId;
  const range = node.range;
  if (!range) throw migrationError(filePath, "the legacy workflow target has no stable source range.");
  const token = text.slice(range[0], range[1]);
  const replacement = renderScalarLike(token, to, filePath);
  const after = Buffer.from(text.slice(0, range[0]) + replacement + text.slice(range[1]));
  return { filePath, from, to, before, after, mode: fs.lstatSync(filePath).mode & 0o777 };
}

/** Preflight every persisted v1 task target without changing disk. */
export function planTaskTargetRefMigration(config: AkmConfig): TaskTargetRefMigrationPlan {
  const bundles = bundlesFromConfig(config);
  const rewrites: TaskTargetRefRewrite[] = [];
  const durabilityPaths: string[] = [];
  for (const bundle of bundles) {
    if (!bundle.writable) continue;
    const tasksDir = path.join(bundle.root, "tasks");
    if (!fs.existsSync(tasksDir)) continue;
    const tasksStat = fs.lstatSync(tasksDir);
    if (tasksStat.isSymbolicLink()) {
      throw new ConfigError(
        `Cannot migrate persisted task targets because ${tasksDir} is a symbolic link. Replace it with a real ` +
          "directory, then rerun `akm migrate apply`.",
        "INVALID_CONFIG_FILE",
      );
    }
    if (!tasksStat.isDirectory()) {
      throw new ConfigError(
        `Cannot migrate persisted task targets because ${tasksDir} is not a directory. Repair it, then rerun ` +
          "`akm migrate apply`.",
        "INVALID_CONFIG_FILE",
      );
    }
    assertRealPathWithin(bundle.root, tasksDir, tasksDir, "the tasks directory resolves outside its bundle.");
    for (const entry of fs
      .readdirSync(tasksDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".yml")) continue;
      const filePath = path.join(tasksDir, entry.name);
      if (!entry.isFile())
        throw migrationError(filePath, "task migration does not follow symbolic links or special files.");
      assertRealPathWithin(bundle.root, filePath, filePath, "the task file resolves outside its bundle.");
      const rewrite = planTaskFile(filePath, bundle, bundles, durabilityPaths);
      if (rewrite) rewrites.push(rewrite);
    }
  }
  return { rewrites, durabilityPaths };
}

function syncParentDirectory(filePath: string): void {
  const fd = fs.openSync(path.dirname(filePath), "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeTaskFileDurably(target: string, content: Buffer, mode: number): void {
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    const fd = fs.openSync(temp, "wx", mode);
    try {
      fs.fchmodSync(fd, mode);
      let offset = 0;
      while (offset < content.byteLength) {
        const written = fs.writeSync(fd, content, offset, content.byteLength - offset);
        if (written <= 0) throw new Error(`Could not make progress writing task migration temp file ${temp}.`);
        offset += written;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
    renamed = true;
    syncParentDirectory(target);
  } catch (error) {
    if (!renamed) fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Apply a preflighted plan with exact-byte fencing and durable atomic writes. */
export function applyTaskTargetRefMigration(plan: TaskTargetRefMigrationPlan): number {
  let rewritten = 0;
  for (const rewrite of plan.rewrites) {
    const current = fs.readFileSync(rewrite.filePath);
    if (current.equals(rewrite.after)) {
      syncParentDirectory(rewrite.filePath);
      continue;
    }
    if (!current.equals(rewrite.before)) {
      throw migrationError(rewrite.filePath, "the task changed after migration preflight; it was left untouched.");
    }
    writeTaskFileDurably(rewrite.filePath, rewrite.after, rewrite.mode);
    rewritten++;
  }
  for (const filePath of plan.durabilityPaths) syncParentDirectory(filePath);
  return rewritten;
}
