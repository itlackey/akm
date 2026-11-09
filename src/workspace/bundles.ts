// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The configured bundles and their settings, and the actions that add, remove, update, rename or configure one. */

import { setConfigValue } from "../commands/config";
import { akmBundleRename } from "../commands/sources/bundle-rename";
import { assembleInfo } from "../commands/sources/info";
import { akmListSources } from "../commands/sources/installed-stashes";
import { loadConfig, mutateConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { getDbPath } from "../core/paths";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getEmbeddingCount } from "../storage/repositories/index-vec-repository";
import { runCli } from "./cli-child";
import { readBundleGitStatus } from "./git-read";
import { configSource, preserveUnrelatedConfig, tryStashDir, workingStashDir } from "./readers";
import { redactForUi } from "./redact";

export async function list() {
  const config = loadConfig();
  const listing = await akmListSources({ stashDir: tryStashDir() ?? "" });
  const cards = await Promise.all(
    listing.sources.map(async (source) => ({
      name: source.name,
      kind: source.kind,
      default: source.default,
      source: source.source,
      path: source.path ?? null,
      writable: source.writable,
      enabled: config.bundles?.[source.name]?.enabled !== false,
      writableSetting: config.bundles?.[source.name]?.writable,
      components: source.components.map((component) => ({
        ...component,
        configured: !!config.bundles?.[source.name]?.components?.[component.name],
      })),
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
  try {
    const db = openReadonlyExistingDatabase(getDbPath());
    if (db) {
      try {
        embeddingCount = getEmbeddingCount(db);
      } finally {
        closeDatabase(db);
      }
    }
  } catch {
    // An index without an embeddings table (older layout) has none.
  }
  const entryCount = info.indexStats.entryCount;
  return {
    defaultBundle: config.defaultBundle ?? null,
    bundles: cards,
    workingStash,
    index: {
      entryCount,
      byType: info.indexStats.byType,
      lastBuiltAt: info.indexStats.lastBuiltAt,
      hasEmbeddings: info.indexStats.hasEmbeddings,
      embeddingCount,
      embeddingCoverage: embeddingCount !== null && entryCount > 0 ? Math.min(1, embeddingCount / entryCount) : null,
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
  return runCli(args, "add");
}

export async function remove(input: { bundle: string; confirm: boolean }) {
  preserveUnrelatedConfig();
  if (input.confirm !== true) throw new UsageError("Confirm removal of this configured bundle first.");
  return runCli(["bundle", "remove", "--yes", "--", configured(name(input.bundle, "bundle"))], "remove");
}

/** Writes only the lockfile, so it never passes config through the sanitizer. */
export async function update(input: { bundle: string }) {
  return runCli(["bundle", "update", "--", configured(name(input.bundle, "bundle"))], "update");
}

/** A dry run returns the plan and writes nothing. */
export async function rename(input: { bundle: string; name: string; dryRun?: boolean }) {
  if (input.dryRun !== true) preserveUnrelatedConfig();
  const result = await akmBundleRename(name(input.bundle, "bundle"), name(input.name, "name"), {
    dryRun: input.dryRun === true,
  });
  return redactForUi(result) as Record<string, unknown>;
}

export function setSettings(input: {
  bundle?: string;
  enabled?: boolean;
  writable?: boolean;
  componentWritability?: Record<string, boolean>;
}) {
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
    if (input.componentWritability !== undefined) {
      for (const [id, writable] of Object.entries(input.componentWritability)) {
        if (!Object.hasOwn(entry.components ?? {}, id) || id.includes(".") || typeof writable !== "boolean") {
          throw new UsageError("Only existing components with a boolean writable value can be changed.");
        }
        updated = setConfigValue(updated, `bundles.${bundle}.components.${id}.writable`, String(writable));
      }
    }
    // Only a write can drop credentials, so a request that changes nothing is never refused.
    if (updated !== current) preserveUnrelatedConfig(current);
    return updated;
  });
  return { saved: result.written };
}
