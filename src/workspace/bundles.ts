// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The configured bundles and their settings, and the actions that add, remove, update, rename or configure one. */

import { setConfigValue } from "../commands/config-cli";
import { assembleInfo } from "../commands/sources/info";
import { akmListSources } from "../commands/sources/installed-stashes";
import { akmSync } from "../commands/sources/sync";
import { loadConfig, mutateConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { getDbPath } from "../core/paths";
import { inspectWriteTarget } from "../core/write-source";
import { deriveSemanticProviderFingerprint } from "../indexer/materialize-embeddings";
import { effectiveEmbedding } from "../llm/embedders/connection";
import { parseRegistryRef } from "../registry/resolve";
import { STARTER_SOURCE } from "../setup/registry-stash-loader";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getEmbeddableEntryCount } from "../storage/repositories/index-entries-repository";
import { getEmbeddingCount } from "../storage/repositories/index-vec-repository";
import { runCli } from "./cli-child";
import { readBundleGitStatus } from "./git-read";
import { interactive } from "./lease";
import { configSource, preserveUnrelatedConfig, tryStashDir, workingStashDir } from "./readers";

/**
 * One name for where a bundle comes from, parsed by the code `bundle add` uses: the same repository or package gives
 * the same identity however its address is written. Null for a folder, a website, or an address that does not parse.
 */
function sourceIdentity(source: { kind: string; locator: string }): string | null {
  if (source.kind !== "git" && source.kind !== "npm") return null;
  try {
    return parseRegistryRef(source.locator).id;
  } catch {
    return null;
  }
}

export async function list() {
  const config = loadConfig();
  const listing = await akmListSources({ stashDir: tryStashDir() ?? "" });
  const cards = await Promise.all(
    listing.sources.map(async (source) => ({
      name: source.name,
      kind: source.kind,
      default: source.default,
      source: source.source,
      identity: sourceIdentity(source.source),
      path: source.path ?? null,
      writable: source.writable,
      // Whether akm would accept a write to this bundle now, and the sentence why not: the write path's own checks.
      writeBlocker: inspectWriteTarget(config, source.name).blocker,
      enabled: config.bundles?.[source.name]?.enabled !== false,
      writableSetting: config.bundles?.[source.name]?.writable,
      adapter: source.adapter,
      detected: source.detected,
      root: config.bundles?.[source.name]?.root ?? ".",
      settingsSource: configSource(["bundles", source.name]),
      version: source.version ?? null,
      exists: source.status.exists,
      itemCount: source.itemCount,
      byType: source.byType,
      git: source.path ? await readBundleGitStatus(source.path) : null,
    })),
  );

  const stashDir = workingStashDir(config);
  const workingStash = stashDir ? { path: stashDir, git: await readBundleGitStatus(stashDir) } : null;

  // The default bundle is the working stash when one is configured: list it first.
  cards.sort((a, b) => Number(b.default) - Number(a.default));

  const info = assembleInfo();
  let embeddingCount: number | null = null;
  let embeddableCount = 0;
  try {
    const db = openReadonlyExistingDatabase(getDbPath());
    if (db) {
      try {
        // The same two counts akm's own readiness test compares: the current model's vectors, the embeddable entries.
        embeddingCount = getEmbeddingCount(db, deriveSemanticProviderFingerprint(effectiveEmbedding(config)));
        embeddableCount = getEmbeddableEntryCount(db);
      } finally {
        closeDatabase(db);
      }
    }
  } catch {
    // An index without an embeddings table (older layout) has none.
  }
  const { entryCount } = info.indexStats;
  return {
    defaultBundle: config.defaultBundle ?? null,
    defaultWriteTarget: config.defaultWriteTarget ?? null,
    // Where a write goes when no bundle is named, and why none does (`name: null`) or why it would be refused.
    writeTarget: inspectWriteTarget(config),
    starter: { source: STARTER_SOURCE, identity: sourceIdentity({ kind: "git", locator: STARTER_SOURCE }) },
    bundles: cards,
    workingStash,
    index: {
      entryCount,
      byType: info.indexStats.byType,
      lastBuiltAt: info.indexStats.lastBuiltAt,
      hasEmbeddings: info.indexStats.hasEmbeddings,
      embeddingCount,
      embeddingCoverage:
        embeddingCount !== null && embeddableCount > 0 ? Math.min(1, embeddingCount / embeddableCount) : null,
      semanticSearch: info.semanticSearch,
      ...(info.indexStats.unavailable ? { unavailable: info.indexStats.unavailable } : {}),
      ...(info.indexStats.unreadable ? { unreadable: info.indexStats.unreadable } : {}),
    },
  };
}

function name(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${key} is required.`);
  return value.trim();
}

/** A target, not a command option: the value goes to the CLI as an argument. */
function positional(value: unknown, key: string): string {
  const text = name(value, key);
  if (text.startsWith("-"))
    throw new UsageError(
      `${key} must be a target, not a command option. Use ./ for a relative path beginning with a dash.`,
    );
  return text;
}

function configured(bundle: string): string {
  if (!Object.hasOwn(loadConfig().bundles ?? {}, bundle))
    throw new UsageError(`No configured bundle named "${bundle}".`);
  return bundle;
}

export async function add(input: { source: string; name?: string; writable?: boolean }) {
  preserveUnrelatedConfig();
  const args = ["bundle", "add", positional(input.source, "source")];
  if (typeof input.name === "string" && input.name.trim()) args.push(`--name=${input.name.trim()}`);
  if (input.writable === true) args.push("--writable");
  return runCli(args);
}

export async function remove(input: { bundle: string; confirm: boolean }) {
  preserveUnrelatedConfig();
  if (input.confirm !== true) throw new UsageError("Confirm removal of this configured bundle first.");
  return runCli(["bundle", "remove", "--yes", "--", configured(name(input.bundle, "bundle"))]);
}

/** Writes only the lockfile, so it never passes config through the sanitizer. */
export async function update(input: { bundle: string }) {
  return runCli(["bundle", "update", "--", configured(name(input.bundle, "bundle"))]);
}

/**
 * `akm index`: the incremental build. It pairs a file renamed or moved on disk with the asset it was and carries the
 * asset's history to the new ref (`moves` in the result), which the write-path index refresh does not do.
 */
export async function index() {
  return (await runCli(["index"])) as {
    totalEntries: number;
    mode: string;
    warnings?: string[];
    moves?: { moved: Array<{ from: string; to: string }>; unpaired: number };
  };
}

/** A dry run returns the plan and writes nothing. */
export async function rename(input: { bundle: string; name: string; dryRun?: boolean }) {
  if (input.dryRun !== true) preserveUnrelatedConfig();
  return runCli([
    "bundle",
    "rename",
    ...(input.dryRun === true ? ["--dry-run"] : []),
    "--",
    name(input.bundle, "bundle"),
    name(input.name, "name"),
  ]);
}

export function setSettings(input: { bundle?: string; enabled?: boolean; writable?: boolean }) {
  // Without a bundle there is nothing to change.
  if (input.bundle === undefined) return { saved: false };
  const result = mutateConfig((current) => {
    let updated = current;
    const bundle = name(input.bundle, "bundle");
    const entry = current.bundles?.[bundle];
    if (!entry || !Object.hasOwn(current.bundles ?? {}, bundle))
      throw new UsageError(`No configured bundle named "${bundle}".`);
    for (const key of ["enabled", "writable"] as const) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== "boolean") throw new UsageError(`${key} must be a boolean.`);
      updated = setConfigValue(updated, `bundles.${bundle}.${key}`, String(input[key]));
    }
    // Only a write can drop credentials, so a request that changes nothing is never refused.
    if (updated !== current) preserveUnrelatedConfig(current);
    return updated;
  });
  return { saved: result.written };
}

/**
 * `akm sync` for one bundle: commit every unignored change inside it, and push when it is writable with a remote. Says what it
 * did: the commit, whether it was pushed, or why nothing was committed (`reason`).
 */
export async function commit(input: { bundle: string; message?: string; push?: boolean }) {
  const bundle = configured(name(input.bundle, "bundle"));
  const message = typeof input.message === "string" && input.message.trim() ? input.message.trim() : undefined;
  return interactive("ui-bundle-commit", async () => ({
    bundle,
    ...akmSync({ name: bundle, message, push: input.push }),
  }));
}
