// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BundleAdapter } from "../../core/adapter/bundle-adapter";
import { adapterForId } from "../../core/adapter/registry";
import type { BundleComponent } from "../../core/adapter/types";
import { type BundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { isContainedResolvedPath, isWithin } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { bundleComponentConfig, bundlesToSourceEntries } from "../../core/config/config-sources";
import type { AkmConfig } from "../../core/config/config-types";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { warnOnce } from "../../core/warn";
import type {
  AdapterRenderedCommandSource,
  AdapterRenderedExecutionSource,
  AdapterRenderedPersonaSource,
} from "../../execution/source";
import { type IndexEntry, lookupBundleRef } from "../../indexer/indexer";
import { deriveInstallations } from "../../indexer/installations";
import { resolveEntryContentDir, resolveSourceEntries } from "../../indexer/search/search-source";
import { buildFileContext, type FileContext } from "../../indexer/walk/file-context";

export type ExecutionSourceLookup = (ref: BundleRef) => Promise<IndexEntry | null>;

export interface LoadAdapterExecutionSourceOptions {
  readonly config?: AkmConfig;
  readonly lookup?: ExecutionSourceLookup;
  readonly adapterFor?: (id: string) => BundleAdapter | undefined;
  /** Guarded execution projection may inject a retained-byte file context. */
  readonly fileContext?: (stashRoot: string, file: string) => FileContext;
}

async function defaultLookup(ref: BundleRef): Promise<IndexEntry | null> {
  return lookupBundleRef(ref);
}

async function effectiveConfig(config: AkmConfig | undefined): Promise<AkmConfig> {
  if (config) return config;
  return loadConfig();
}

function realDirectory(value: string, label: string): string {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(value);
    stat = fs.statSync(real);
  } catch {
    throw new NotFoundError(`${label} is missing or unreadable. Rebuild the index and retry.`, "FILE_NOT_FOUND");
  }
  if (!stat.isDirectory()) throw new ConfigError(`${label} is not a directory.`, "INVALID_CONFIG_FILE");
  return real;
}

function realRegularFile(value: string, label: string): string {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(value);
    stat = fs.statSync(real);
  } catch {
    throw new NotFoundError(
      `${label} is stale, missing, or unreadable. Rebuild the index and retry.`,
      "FILE_NOT_FOUND",
    );
  }
  if (!stat.isFile()) throw new NotFoundError(`${label} is not a regular file.`, "FILE_NOT_FOUND");
  return real;
}

function isLexicallyWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function implicitComponentForEntry(entry: IndexEntry, config: AkmConfig): BundleComponent | undefined {
  const sources = resolveSourceEntries(undefined, config);
  const installations = deriveInstallations(sources);
  for (const [index, installation] of installations.entries()) {
    if (installation.id !== entry.bundleId) continue;
    const source = sources[index];
    const component = installation.components[0];
    if (!source || !component) continue;
    const canonicalRoot = realDirectory(component.root, `Canonical implicit source root for ${entry.bundleId}`);
    if (component.adapter !== entry.adapterId) {
      warnOnce(
        `execution-source-adapter-drift:${entry.itemRef}`,
        `[command] Indexed adapter ${JSON.stringify(entry.adapterId)} for ${JSON.stringify(entry.itemRef)} no longer matches the working source's adapter ${JSON.stringify(component.adapter)}; re-resolving from live config. Run \`akm index --full\` to refresh it.`,
      );
    }
    return Object.freeze({
      id: installation.id,
      adapter: component.adapter,
      root: canonicalRoot,
      writable: component.writable,
    });
  }
  return undefined;
}

function componentForEntry(entry: IndexEntry, config: AkmConfig, realRoot: string): BundleComponent {
  const configured = config.bundles?.[entry.bundleId];
  if (!configured) {
    const implicit = implicitComponentForEntry(entry, config);
    if (implicit) return implicit;
    throw new ConfigError(
      `Indexed execution source ${JSON.stringify(entry.itemRef)} belongs to unconfigured bundle ${JSON.stringify(entry.bundleId)}.`,
      "INVALID_CONFIG_FILE",
      "Refresh the bundle configuration and rebuild the index before dispatching this asset.",
    );
  }
  const component = bundleComponentConfig(configured);
  const configuredAdapter = component?.adapter;
  if (configuredAdapter && configuredAdapter !== entry.adapterId) {
    warnOnce(
      `execution-source-adapter-drift:${entry.itemRef}`,
      `[command] Indexed adapter ${JSON.stringify(entry.adapterId)} for ${JSON.stringify(entry.itemRef)} no longer matches the bundle config's adapter ${JSON.stringify(configuredAdapter)}; re-resolving from live config. Run \`akm index --full\` to refresh it.`,
    );
  }
  const configuredSource = bundlesToSourceEntries(config)?.find((source) => source.name === entry.bundleId);
  const configuredContentRoot = configuredSource ? resolveEntryContentDir(configuredSource) : undefined;
  if (!configuredSource || !configuredContentRoot) {
    warnOnce(
      `execution-source-unresolved:${entry.itemRef}`,
      `[command] Configured source for ${JSON.stringify(entry.itemRef)} no longer resolves to materialized content; dispatching from the indexed location instead. Run \`akm index --full\` after restoring or updating the bundle.`,
    );
  } else {
    const lexicalSourceRoot = path.resolve(configuredContentRoot);
    const lexicalConfiguredRoot = path.resolve(configuredContentRoot, component?.root ?? ".");
    if (!isLexicallyWithin(lexicalConfiguredRoot, lexicalSourceRoot)) {
      throw new ConfigError(
        `Configured component root for ${JSON.stringify(entry.itemRef)} resolves outside its materialized bundle source.`,
        "INVALID_CONFIG_FILE",
        "Keep component roots inside their owning bundle source, then run `akm index --full`.",
      );
    }
    const configuredSourceRoot = realDirectory(lexicalSourceRoot, `Configured source root for ${entry.bundleId}`);
    let configuredRoot: string;
    try {
      configuredRoot = realDirectory(lexicalConfiguredRoot, `Configured component root for ${entry.bundleId}`);
    } catch {
      throw new ConfigError(
        `Configured ${JSON.stringify(configuredSource.type)} source for ${JSON.stringify(entry.itemRef)} is not materialized at its current component root.`,
        "INVALID_CONFIG_FILE",
        "Restore or update the bundle, then run `akm index --full` before dispatching this asset.",
      );
    }
    if (!isWithin(configuredRoot, configuredSourceRoot)) {
      throw new ConfigError(
        `Configured component root for ${JSON.stringify(entry.itemRef)} resolves outside its materialized bundle source.`,
        "INVALID_CONFIG_FILE",
        "Remove the escaping symlink or component path, then run `akm index --full`.",
      );
    }
  }
  const writable = component?.writable ?? configured.writable ?? configured.path !== undefined;
  return Object.freeze({
    id: entry.bundleId,
    adapter: entry.adapterId,
    root: realRoot,
    writable,
  });
}

function expectedIndexedType(kind: "command" | "persona"): string {
  return kind === "command" ? "command" : "agent";
}

function assertRenderedIdentity(source: AdapterRenderedExecutionSource, entry: IndexEntry, content: string): void {
  const expectedFile = path.relative(path.resolve(entry.stashDir), path.resolve(entry.filePath)).replace(/\\/g, "/");
  const expectedHash = createHash("sha256").update(content, "utf8").digest("hex");
  if (
    source.identity.ref !== entry.itemRef ||
    source.identity.bundle !== entry.bundleId ||
    source.identity.adapter !== entry.adapterId ||
    source.identity.file !== expectedFile ||
    source.identity.hash !== expectedHash
  ) {
    throw new ConfigError(
      `Execution renderer identity drift for ${JSON.stringify(entry.itemRef)}.`,
      "INVALID_CONFIG_FILE",
      "Run `akm index --full`; if the mismatch remains, repair the owning bundle adapter.",
    );
  }
}

export async function loadAdapterExecutionSource(
  refInput: string,
  expectedKind: "command",
  options?: LoadAdapterExecutionSourceOptions,
): Promise<AdapterRenderedCommandSource>;
export async function loadAdapterExecutionSource(
  refInput: string,
  expectedKind: "persona",
  options?: LoadAdapterExecutionSourceOptions,
): Promise<AdapterRenderedPersonaSource>;
export async function loadAdapterExecutionSource(
  refInput: string,
  expectedKind: "command" | "persona",
  options: LoadAdapterExecutionSourceOptions = {},
): Promise<AdapterRenderedExecutionSource> {
  const parsed = parseBundleRef(refInput);
  if (parsed.fragment !== undefined) {
    throw new UsageError(
      `Execution source ${JSON.stringify(refInput)} cannot select a fragment.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const entry = await (options.lookup ?? defaultLookup)(parsed);
  if (!entry) {
    throw new NotFoundError(
      `Execution source ${JSON.stringify(refInput)} was not found in the local index.`,
      "ASSET_NOT_FOUND",
      "Run `akm index --full`, then retry the command ref.",
    );
  }
  const indexedType = expectedIndexedType(expectedKind);
  if (entry.type !== indexedType) {
    throw new UsageError(
      `Execution source ${JSON.stringify(refInput)} resolves to type ${JSON.stringify(entry.type)}, expected ${JSON.stringify(indexedType)}.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const config = await effectiveConfig(options.config);
  const realRoot = realDirectory(entry.stashDir, `Indexed component root for ${entry.itemRef}`);
  realRegularFile(entry.filePath, `Indexed execution source ${entry.itemRef}`);
  // An index row must name a file inside its own component root. Checked on the
  // authored path, so a file that is a symlink to one elsewhere still loads.
  if (!isContainedResolvedPath(path.resolve(entry.filePath), path.resolve(entry.stashDir))) {
    throw new ConfigError(
      `Indexed execution source ${JSON.stringify(entry.itemRef)} resolves outside its component root.`,
      "INVALID_CONFIG_FILE",
      "Remove the escaping path and rebuild the index.",
    );
  }
  const component = componentForEntry(entry, config, realRoot);
  const adapter = (options.adapterFor ?? adapterForId)(entry.adapterId);
  if (!adapter) {
    throw new ConfigError(
      `Execution source adapter ${JSON.stringify(entry.adapterId)} is not registered.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (!adapter.renderExecutionSource) {
    throw new UsageError(
      `Bundle adapter ${JSON.stringify(entry.adapterId)} does not support command or persona execution.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const fileContext = (options.fileContext ?? buildFileContext)(entry.stashDir, entry.filePath);
  const rendered = adapter.renderExecutionSource(component, fileContext);
  if (!rendered || rendered.kind !== expectedKind) {
    throw new ConfigError(
      `Bundle adapter ${JSON.stringify(entry.adapterId)} did not render ${JSON.stringify(entry.itemRef)} as a ${expectedKind}.`,
      "INVALID_CONFIG_FILE",
      "Rebuild the index; if the mismatch remains, repair the source file or owning adapter.",
    );
  }
  assertRenderedIdentity(rendered, entry, fileContext.content());
  return rendered;
}
