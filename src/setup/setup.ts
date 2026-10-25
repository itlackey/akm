// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Configuration wizard for akm.
 *
 * Walks users through the agent programs to enable, a model connection,
 * embeddings, registry selection and bundle sources, then writes the config
 * once at the end. Flags answer individual questions; `--yes` takes the
 * detected default for every question left.
 *
 * This module holds the wizard orchestration; the individual wizard steps, the
 * pure config builder, prompt shims and semantic-asset preparation live in
 * sibling modules (`steps/*`, `engine-plan`, `prompt`, `semantic-assets`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as p from "../cli/clack";
import { akmInit } from "../commands/sources/init";
import { deriveBundleIds } from "../core/bundle-id";
import type { AkmConfig, BundleConfigEntry, SourceConfigEntry } from "../core/config/config";
import {
  bundleEntryToSourceEntry,
  DEFAULT_CONFIG,
  loadUserConfig,
  mutateConfigWithPrecommit,
  parseAndValidateConfigText,
  primaryBundlePath,
  validateCompleteConfig,
} from "../core/config/config";
import { readConfigText } from "../core/config/config-io";
import { listTopLevelConfigKeys } from "../core/config/config-schema";
import { writeCredential } from "../core/config/credentials";
import { deepMergeConfig, isPlainObject } from "../core/config/deep-merge";
import { ConfigError, UsageError } from "../core/errors";
import { getConfigPath, getDefaultStashDir, isTransientStashPath } from "../core/paths";
import { warn, warnOnce } from "../core/warn";
import { akmIndex } from "../indexer/indexer";
import { readLockfile } from "../integrations/lockfile";
import { type DetectedEnvironment, detectEnvironment, renderDetectionSummary } from "./detect";
import type { EngineFlags } from "./engine-flags";
import { applyEngineAnswers, type EngineAnswers } from "./engine-plan";
import { bail, prompt } from "./prompt";
import { prepareSemanticSearchAssets } from "./semantic-assets";
import { canonicalSetupGitUrl } from "./source-identity";
import { createSetupContext, runSetupSteps, type SetupContext, type SetupDraftConfig, type SetupStep } from "./steps";
import { type ConnectionStepResult, stepConnection } from "./steps/connection";
import { type SemanticSearchChoice, stepEmbeddings } from "./steps/embeddings";
import { type HarnessStepResult, stepHarnesses } from "./steps/harnesses";
import { stepOutputConfig } from "./steps/output";
import { stepAgentPlatforms } from "./steps/platforms";
import { stepAdditionalSources, stepAddSources, stepRegistries } from "./steps/sources";
import { stepStashDir } from "./steps/stashdir";
import { stepScheduledTasks } from "./steps/tasks";
import { describeRuns, type SetupRuns } from "./summary";

// ── Setup sandbox guard ─────────────────────────────────────────────────────

/**
 * Warn when an explicit `--dir /tmp/...` is persisted as the default bundle
 * path — `akm setup --dir $(mktemp -d)` resolves under this family on every
 * macOS machine (`/var/folders/...`), and used to be refused outright with
 * no discoverable remedy. The OS may reap the directory at any time, so the
 * operator is told up front; `applyStashIsolationToEnv` below still pre-sets
 * `AKM_BUNDLE_DIR` so the `getConfigDir` / `getCacheDir` isolation rules
 * (`core/paths.ts`) route config + cache writes into `$stashDir/.akm/`
 * instead of the user's host `~/.config/akm`, which is what actually
 * protects the host config (the 2026-05-23 setup-clobbers-user-config
 * incident this guard traces to).
 */
export function assertSetupSandbox(stashDir: string, dirExplicitlyProvided: boolean): void {
  if (!dirExplicitlyProvided) return;
  if (!isTransientStashPath(stashDir)) return;
  warnOnce(
    `setup-tmp-stash:${stashDir}`,
    `\`akm setup --dir ${stashDir}\` targets a transient/sandbox directory the OS may reap at any time; ` +
      `the next run would then point at a deleted bundle. Config and cache writes are isolated into ` +
      `${stashDir}/.akm/ so the host config is unaffected, but treat this stash as disposable.`,
  );
}

/**
 * Propagate the explicit `--dir <stashDir>` choice to the env so that the
 * `getConfigDir` / `getCacheDir` isolation rules in `src/core/paths.ts`
 * actually fire for the duration of this setup run. Without this, a CLI
 * caller who passes `--dir /tmp/X` but doesn't pre-export `AKM_BUNDLE_DIR`
 * would still write config to the host `~/.config/akm/config.json`. We
 * only set the env var when:
 *   - `--dir` was explicitly provided (we have an operator-stated stash), AND
 *   - `AKM_BUNDLE_DIR` is not already set (caller's explicit env wins).
 * The set is process-wide; for the CLI that's the right scope (the process
 * is about to do all its work against this stash). For tests, each test
 * already isolates env via beforeEach/afterEach so there is no leak.
 */
function applyStashIsolationToEnv(stashDir: string, dirExplicitlyProvided: boolean): void {
  if (!dirExplicitlyProvided) return;
  if (process.env.AKM_BUNDLE_DIR?.trim()) return;
  process.env.AKM_BUNDLE_DIR = stashDir;
}

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SetupSummary {
  configPath: string;
  bundleDir: string;
  stashCreated: boolean;
  written: boolean;
  fields: string[];
  /** What runs where once setup is done. */
  runs: SetupRuns;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Raw preflight used before setup performs prompts, initialization, or writes.
 *
 * Setup merges into a current config, so it rejects an unreadable or obsolete
 * file before prompting or writing. There is no runtime config translator: an
 * operator who wants a fresh setup moves the old file aside, while an operator
 * who wants to preserve its values rewrites them into the current schema.
 */
export function assertSetupConfigPreflight(): void {
  const configPath = getConfigPath();
  let text: string | undefined;
  try {
    text = readConfigText(configPath);
  } catch (error) {
    throw new ConfigError(
      `Could not read config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (text === undefined) return;
  try {
    parseAndValidateConfigText(text, configPath);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (error.code !== "INVALID_CONFIG_FILE") throw error;
    throw new ConfigError(
      `\`akm setup\` cannot run: the config at ${configPath} did not load (${error.message}). ` +
        "It was left untouched — setup never writes over a config it cannot first read cleanly.",
      error.code,
      "Rewrite the file using the current config schema, or move it aside to start fresh " +
        `(e.g. \`mv ${configPath} ${configPath}.bak\`) and re-run \`akm setup\`.`,
    );
  }
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function configArrayItemKey(value: unknown): string {
  if (!isPlainObject(value)) return `value:${JSON.stringify(value)}`;
  if (typeof value.id === "string") return `id:${value.id}`;
  if (typeof value.type === "string" && typeof value.url === "string") return `source:${value.type}:url:${value.url}`;
  if (typeof value.type === "string" && typeof value.path === "string")
    return `source:${value.type}:path:${path.resolve(value.path)}`;
  if (typeof value.url === "string") return `url:${value.url}`;
  if (typeof value.name === "string") return `name:${value.name}`;
  return `value:${JSON.stringify(value)}`;
}

function setupConflict(pathParts: readonly string[]): never {
  const field = pathParts.length > 0 ? pathParts.join(".") : "(root)";
  throw new ConfigError(
    `Setup config conflict at ${field}: another process changed the same field after setup started. Rerun setup against the latest config.`,
    "INVALID_CONFIG_FILE",
  );
}

/** Reapply setup's changes while rejecting concurrent edits to the same field. */
export function rebaseSetupChanges(
  original: unknown,
  desired: unknown,
  latest: unknown,
  pathParts: readonly string[] = [],
): unknown {
  if (sameConfigValue(original, desired)) return latest;
  if (Array.isArray(original) && Array.isArray(desired)) {
    if (latest !== undefined && !Array.isArray(latest)) setupConflict(pathParts);
    const latestItems = Array.isArray(latest) ? latest : [];
    const originalByKey = new Map(original.map((item) => [configArrayItemKey(item), item]));
    const desiredByKey = new Map(desired.map((item) => [configArrayItemKey(item), item]));
    const latestByKey = new Map(latestItems.map((item) => [configArrayItemKey(item), item]));
    const result: unknown[] = [];
    for (const [key, desiredItem] of desiredByKey) {
      const originalItem = originalByKey.get(key);
      const latestItem = latestByKey.get(key);
      if (originalByKey.has(key)) {
        if (!latestByKey.has(key)) setupConflict([...pathParts, key]);
        result.push(rebaseSetupChanges(originalItem, desiredItem, latestItem, [...pathParts, key]));
      } else if (!latestByKey.has(key) || sameConfigValue(latestItem, desiredItem)) {
        result.push(desiredItem);
      } else {
        setupConflict([...pathParts, key]);
      }
    }
    for (const [key, originalItem] of originalByKey) {
      if (desiredByKey.has(key) || !latestByKey.has(key)) continue;
      if (!sameConfigValue(latestByKey.get(key), originalItem)) setupConflict([...pathParts, key]);
    }
    for (const item of latestItems) {
      const key = configArrayItemKey(item);
      if (!originalByKey.has(key) && !desiredByKey.has(key)) result.push(item);
    }
    return result;
  }
  if (!isPlainObject(original) || !isPlainObject(desired)) {
    if (!sameConfigValue(latest, original) && !sameConfigValue(latest, desired)) setupConflict(pathParts);
    return desired;
  }
  if (latest !== undefined && !isPlainObject(latest)) setupConflict(pathParts);
  const result: Record<string, unknown> = isPlainObject(latest) ? { ...latest } : {};
  for (const key of new Set([...Object.keys(original), ...Object.keys(desired)])) {
    if (!Object.hasOwn(desired, key)) {
      if (Object.hasOwn(result, key) && !sameConfigValue(result[key], original[key]))
        setupConflict([...pathParts, key]);
      delete result[key];
      continue;
    }
    result[key] = rebaseSetupChanges(original[key], desired[key], result[key], [...pathParts, key]);
  }
  return result;
}

async function saveSetupConfig<T>(
  original: AkmConfig,
  desired: AkmConfig,
  precommit: (config: AkmConfig) => Promise<T>,
  options?: { persistTopLevelKeys?: readonly (keyof AkmConfig)[] },
): Promise<{ config: AkmConfig; precommit: T }> {
  const result = await mutateConfigWithPrecommit(
    (latest) => rebaseSetupChanges(original, desired, latest) as AkmConfig,
    precommit,
    options,
  );
  return { config: result.config, precommit: result.precommit };
}

/** Registry-managed bundles are not editable through setup's source picker. */
function managedBundleIds(): Set<string> {
  return new Set(readLockfile().map((entry) => entry.id));
}

function setupSourceDescriptor(source: SourceConfigEntry): BundleConfigEntry | undefined {
  switch (source.type) {
    case "filesystem":
      return source.path ? { path: source.path } : undefined;
    case "git":
      return source.url ? { git: source.url } : undefined;
    case "website":
      return source.url ? { website: { url: source.url, ...(source.options ?? {}) } } : undefined;
    case "npm":
      return source.path ? { npm: source.path } : undefined;
    default:
      return undefined;
  }
}

function selectsExistingBundle(source: SourceConfigEntry, id: string, bundle: BundleConfigEntry): boolean {
  const configured = bundleEntryToSourceEntry(id, bundle);
  const sameUrl =
    configured?.type === "git" && source.type === "git" && configured.url && source.url
      ? canonicalSetupGitUrl(configured.url) === canonicalSetupGitUrl(source.url)
      : configured?.url === source.url;
  return configured !== undefined && configured.type === source.type && configured.path === source.path && sameUrl;
}

type NewSetupBundle = {
  descriptor: BundleConfigEntry;
  derivationPath: string;
  preferredId?: string;
  primary: boolean;
  writable?: boolean;
};

/** Convert only the wizard's private drafts, leaving current bundle entries intact. */
function finalizeSetupDraft(draft: SetupDraftConfig): AkmConfig {
  const { primaryPath, additionalSources, ...canonical } = draft;
  const finalized = canonical as AkmConfig;
  if (primaryPath === undefined && additionalSources === undefined) return finalized;

  const bundles: Record<string, BundleConfigEntry> = { ...(draft.bundles ?? {}) };
  const managedIds = managedBundleIds();
  const newBundles: NewSetupBundle[] = [];

  if (additionalSources !== undefined) {
    const selectedExistingIds = new Set<string>();
    for (const source of additionalSources) {
      const existing = source.name ? bundles[source.name] : undefined;
      if (
        source.name &&
        source.name !== draft.defaultBundle &&
        existing &&
        selectsExistingBundle(source, source.name, existing)
      ) {
        selectedExistingIds.add(source.name);
        continue;
      }

      const descriptor = setupSourceDescriptor(source);
      if (!descriptor) continue;
      newBundles.push({
        descriptor,
        derivationPath: source.path ? path.resolve(source.path) : (source.url ?? ""),
        preferredId: source.name,
        primary: false,
        writable: source.writable,
      });
    }

    for (const id of Object.keys(bundles)) {
      if (id === draft.defaultBundle || managedIds.has(id) || selectedExistingIds.has(id)) continue;
      delete bundles[id];
    }
  }

  let defaultBundle = draft.defaultBundle;
  const configuredPrimaryPath = primaryBundlePath(draft);
  if (
    primaryPath !== undefined &&
    (configuredPrimaryPath === undefined || path.resolve(configuredPrimaryPath) !== path.resolve(primaryPath))
  ) {
    if (defaultBundle && !managedIds.has(defaultBundle)) delete bundles[defaultBundle];
    defaultBundle = undefined;
    newBundles.unshift({
      descriptor: { path: primaryPath },
      derivationPath: path.resolve(primaryPath),
      primary: true,
      writable: true,
    });
  }

  const reserved = Object.keys(bundles).map((id) => ({ path: id, registryId: id }));
  const ids = deriveBundleIds([
    ...reserved,
    ...newBundles.map((bundle) => ({ path: bundle.derivationPath, registryId: bundle.preferredId })),
  ]).slice(reserved.length);
  for (const [index, bundle] of newBundles.entries()) {
    const id = ids[index] as string;
    bundles[id] = {
      ...bundle.descriptor,
      ...(bundle.writable !== undefined ? { writable: bundle.writable } : {}),
    };
    if (bundle.primary) defaultBundle = id;
  }

  if (Object.keys(bundles).length > 0) finalized.bundles = bundles;
  else delete finalized.bundles;
  if (defaultBundle !== undefined) finalized.defaultBundle = defaultBundle;
  else delete finalized.defaultBundle;
  return finalized;
}

// ── Main Wizard ─────────────────────────────────────────────────────────────

/** What the steps decide that is not config: the semantic-search choice, and keys bound for `credentials.json`. */
interface SetupOutcome {
  semantic: SemanticSearchChoice;
  credentials: Record<string, string>;
}

const NOTHING_DETECTED: DetectedEnvironment = {
  harnesses: [],
  providers: [],
  localServers: [],
  stashSuggestions: [],
  agentPlatforms: [],
};

/**
 * Build the canonical list of `SetupStep`s for the interactive wizard.
 * Exposed (and exported) so tests and `akm init` can compose subsets.
 *
 * Each step wraps the existing `step*` functions, accumulating its result
 * into the shared `SetupContext`. The `nonInteractive` flag controls
 * inclusion in `akm init` (a non-interactive preset of `akm setup`): the
 * engine steps run there too, answering from flags and detected defaults.
 */
export function buildSetupSteps(options: {
  semanticSearchOutcome: SemanticSearchChoice;
  preferredStashDir?: string;
  detection?: DetectedEnvironment;
  flags?: EngineFlags;
  /** Contact endpoints to list their models; false for an offline run. */
  probe?: boolean;
}): {
  steps: SetupStep[];
  /** Latest semantic-search choice and pending keys; populated by the engine steps. */
  outcome: SetupOutcome;
} {
  const outcome: SetupOutcome = { semantic: options.semanticSearchOutcome, credentials: {} };
  const detection = options.detection ?? NOTHING_DETECTED;
  const flags = options.flags ?? {};
  const probe = options.probe !== false;
  // What an earlier engine step decided that a later one builds on.
  let harness: HarnessStepResult = { modelCallsOnHarness: false };
  let connection: ConnectionStepResult = { listed: [], addedDefault: false };

  const applyAnswers = (ctx: SetupContext, answers: EngineAnswers): void => {
    const change = applyEngineAnswers(ctx.config, answers);
    ctx.replace(change.patch);
    Object.assign(outcome.credentials, change.credentials);
  };

  const steps: SetupStep[] = [
    {
      id: "stash-dir",
      label: "Bundle Directory",
      nonInteractive: true,
      async run(ctx) {
        const stashDir = await stepStashDir(ctx.config, {
          nonInteractive: ctx.nonInteractive,
          preferredDir: options.preferredStashDir,
        });
        ctx.apply({ primaryPath: stashDir });
      },
    },
    {
      id: "harnesses",
      label: "Agent Programs",
      nonInteractive: true,
      async run(ctx) {
        harness = await stepHarnesses({
          current: ctx.config,
          installed: detection.harnesses,
          flags,
          interactive: !ctx.nonInteractive,
        });
        applyAnswers(ctx, { harnesses: harness.answer });
      },
    },
    {
      id: "connection",
      label: "Connection",
      nonInteractive: true,
      async run(ctx) {
        connection = await stepConnection({
          current: ctx.config,
          flags,
          interactive: !ctx.nonInteractive,
          probe,
          modelCallsOnHarness: harness.modelCallsOnHarness,
          localServers: detection.localServers,
        });
        applyAnswers(ctx, { connection: connection.answer });
      },
    },
    {
      id: "embeddings",
      label: "Embeddings",
      nonInteractive: true,
      async run(ctx) {
        const embeddings = await stepEmbeddings({
          current: ctx.config,
          flags,
          interactive: !ctx.nonInteractive,
          probe,
          connection: connection.answer,
          listed: connection.listed,
          addedDefaultConnection: connection.addedDefault,
        });
        applyAnswers(ctx, { embedding: embeddings.answer });
        outcome.semantic = embeddings.semantic;
        ctx.apply({ semanticSearchMode: embeddings.semantic.mode });
      },
    },
    {
      id: "registries",
      label: "Registries",
      async run(ctx) {
        const registries = await stepRegistries(ctx.config);
        ctx.apply({ registries });
      },
    },
    {
      id: "stash-sources",
      label: "Bundle Sources",
      async run(ctx) {
        const stashes = await stepAddSources(ctx.config, { promptForAdditional: false });
        const platforms = await stepAgentPlatforms({ ...ctx.config, additionalSources: stashes });
        const merged = [...stashes];
        for (const ps of platforms) {
          if (!merged.some((s) => s.path === ps.path)) merged.push(ps);
        }
        const withAdditional = await stepAdditionalSources(merged);
        ctx.apply({ additionalSources: withAdditional });
      },
    },
    {
      id: "output",
      label: "Output Defaults",
      async run(ctx) {
        const output = await stepOutputConfig(ctx.config);
        ctx.apply({ output });
      },
    },
    // NOTE: the "Scheduled Tasks" step is deliberately NOT part of this list.
    // It is the only wizard step with externally-visible side effects (task
    // files + OS scheduler entries), so `runSetupWizard` runs it by hand AFTER
    // the config is confirmed and persisted — see the call there. Keeping it
    // out of the step list also preserves the issue #512 guard: the
    // non-interactive entry points (`akm init` / `--yes`) run this list but
    // never that step, so headless runs never enable a scheduled task.
  ];

  return { steps, outcome };
}

/** Keys the user typed at a masked prompt, filed under the name of the block they belong to. */
function storeCredentials(credentials: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(credentials)) writeCredential(name, value);
}

/**
 * Resolve the stash directory, apply stash isolation, and THEN read the config.
 *
 * Order is the whole point. The pre-isolation read exists only to discover
 * where the stash is; `applyStashIsolationToEnv` can repoint AKM_CONFIG_DIR,
 * after which both the config contents and `getConfigPath()` differ. Reading
 * the merge base before isolation meant an isolated run merged the wizard's
 * answers onto the HOST config and reported the host path as the save target
 * while writing somewhere else.
 */
function resolveIsolatedSetupConfig(opts?: { dir?: string }): {
  current: ReturnType<typeof loadUserConfig>;
  configPath: string;
  resolvedStashDir: string;
} {
  const preIsolationConfig = loadUserConfig();

  // Resolve stash directory early so akmInit can run before any prompts.
  const resolvedStashDir = opts?.dir
    ? path.resolve(opts.dir)
    : (primaryBundlePath(preIsolationConfig) ?? getDefaultStashDir());

  // Refuse explicit --dir /tmp/... before doing any work — protects the host
  // config from being clobbered with a stashDir that the OS may reap.
  assertSetupSandbox(resolvedStashDir, opts?.dir != null);
  applyStashIsolationToEnv(resolvedStashDir, opts?.dir != null);

  return { current: loadUserConfig(), configPath: getConfigPath(), resolvedStashDir };
}

export async function runSetupWizard(opts?: {
  dir?: string;
  noInit?: boolean;
  flags?: EngineFlags;
  noProbe?: boolean;
}): Promise<void> {
  assertSetupConfigPreflight();
  p.intro("akm setup");

  const { current, configPath, resolvedStashDir } = resolveIsolatedSetupConfig(opts);

  // Aggregate environment detection — run once before any prompt and surface
  // a summary so the user sees what was auto-detected. NAMES only, never
  // API key values.
  const detection = await detectEnvironment({
    existingStashDir: primaryBundlePath(current),
    probe: opts?.noProbe !== true,
  });
  p.note(renderDetectionSummary(detection), "Detected environment");

  const ctx = createSetupContext(current, { nonInteractive: false });
  const { steps, outcome } = buildSetupSteps({
    semanticSearchOutcome: { mode: current.semanticSearchMode, prepareAssets: false },
    preferredStashDir: resolvedStashDir,
    detection,
    flags: opts?.flags,
    probe: opts?.noProbe !== true,
  });

  // Wrap each step with a `p.log.step()` header so the wizard UI is
  // unchanged. The canonical `runSetupSteps()` runner is used directly by
  // `akm init` (non-interactive) and by tests.
  const labeledSteps: SetupStep[] = steps.map((step) => ({
    ...step,
    async run(stepCtx) {
      p.log.step(step.label);
      await step.run(stepCtx);
    },
  }));
  await runSetupSteps(labeledSteps, ctx);

  const newConfig: SetupDraftConfig = { ...ctx.config };
  const semanticSearchMode = outcome.semantic;
  const stashDir = newConfig.primaryPath ?? primaryBundlePath(current) ?? getDefaultStashDir();
  const registries = newConfig.registries;
  const allStashes = newConfig.additionalSources ?? [];

  // Confirm before saving
  const effectiveRegistries = registries ?? DEFAULT_CONFIG.registries ?? [];
  const runs = describeRuns(newConfig);
  p.note(
    [
      `Bundle directory: ${stashDir}`,
      `Model calls:      ${runs.modelCalls}`,
      `Agent work:       ${runs.agentWork}`,
      `Embeddings:       ${runs.embeddings}`,
      `Semantic search:  ${semanticSearchMode.mode}`,
      `Registries:       ${effectiveRegistries.filter((r) => r.enabled !== false).length} enabled`,
      `Bundle sources:   ${allStashes.length}`,
      `Output:           ${newConfig.output?.format ?? "json"} / ${newConfig.output?.detail ?? "brief"}`,
    ].join("\n"),
    "Configuration Summary",
  );

  const shouldSave = await prompt(() =>
    p.confirm({
      message: "Save this configuration?",
      initialValue: true,
    }),
  );
  if (!shouldSave) bail();

  const finalConfig = finalizeSetupDraft(newConfig);
  validateCompleteConfig(finalConfig);
  const { config: savedConfig } = await saveSetupConfig(
    current,
    finalConfig,
    async () => {
      storeCredentials(outcome.credentials);
      if (!opts?.noInit) await akmInit({ dir: stashDir, setDefault: true, persistConfig: false });
    },
    { persistTopLevelKeys: ["semanticSearchMode"] },
  );

  // After config persistence, the task step reviews the plan and asks one
  // explicit confirmation before changing task files or scheduler state.
  // Non-interactive setup paths never reach this interactive-only step.
  p.log.step("Scheduled Tasks");
  await stepScheduledTasks();

  if (semanticSearchMode.mode === "auto") {
    if (semanticSearchMode.prepareAssets) {
      const ready = await prepareSemanticSearchAssets(savedConfig);
      if (!ready.ok) {
        p.log.warn(
          "Semantic search remains set to auto, but is currently blocked. Re-run `akm index --full --verbose` once the issue is resolved.",
        );
      }
    } else {
      p.log.info(
        "Semantic search is set to auto, but asset preparation was skipped. Run `akm index --full --verbose` later to verify it.",
      );
    }
  }

  // Build search index
  p.log.info("Building search index...");
  const spin = p.spinner();
  spin.start("Building search index...");
  try {
    const indexResult = await akmIndex({ stashDir });
    spin.stop(`Indexed ${indexResult.totalEntries} assets.`);
    if (savedConfig.semanticSearchMode === "auto") {
      if (indexResult.verification.ok) {
        p.log.success(indexResult.verification.message);
      } else {
        p.log.warn(indexResult.verification.message);
        if (indexResult.verification.guidance) {
          p.log.info(indexResult.verification.guidance);
        }
      }
    }
  } catch (err) {
    spin.stop("Indexing failed — you can run `akm index` manually later.");
    p.log.warn(String(err));
  }

  p.outro(
    `Configuration saved to ${configPath}\n` +
      'Next: `akm bundle add <source>`, `akm index`, `akm search "<query>"`, `akm hints`',
  );
}

// ── Non-interactive / scripting entry points ─────────────────────────────────

/**
 * Run the setup steps with no prompts: the flags answer what they cover and the
 * detected default answers the rest. Nothing the config already holds is
 * overwritten except by a flag.
 */
async function applyNonInteractiveDefaults(
  base: SetupDraftConfig,
  stashDir: string,
  opts: { noProbe?: boolean; flags?: EngineFlags },
): Promise<{ config: SetupDraftConfig; credentials: Record<string, string> }> {
  const detection = await detectEnvironment({
    existingStashDir: primaryBundlePath(base),
    probe: opts.noProbe !== true,
  });
  const ctx = createSetupContext(base, { nonInteractive: true });
  const { steps, outcome } = buildSetupSteps({
    semanticSearchOutcome: { mode: base.semanticSearchMode, prepareAssets: false },
    preferredStashDir: stashDir,
    detection,
    flags: opts.flags,
    probe: opts.noProbe !== true,
  });
  await runSetupSteps(steps, ctx);
  if (!ctx.config.primaryPath) ctx.apply({ primaryPath: stashDir });
  return { config: ctx.config, credentials: outcome.credentials };
}

/**
 * Run setup in non-interactive mode, applying all defaults.
 * Safe to call from CI or scripts. Idempotent — re-running produces the same result.
 */
export async function runSetupWithDefaults(opts: {
  dir?: string;
  noInit?: boolean;
  flags?: EngineFlags;
  noProbe?: boolean;
}): Promise<SetupSummary> {
  assertSetupConfigPreflight();
  const explicitStashDir = opts.dir != null ? path.resolve(opts.dir) : undefined;
  // R-066 #4: a second `assertSetupSandbox(stashDir, explicitStashDir != null)`
  // + `applyStashIsolationToEnv(stashDir, explicitStashDir != null)` pair used
  // to follow `stashDir`'s resolution below. It was strictly redundant: unlike
  // `runSetupFromConfig` (which can also derive an explicit stash dir from an
  // incoming config file's bundle path, a case the early block below can't
  // see yet), `runSetupWithDefaults` has only one source of an explicit dir —
  // `opts.dir` — so `stashDir` always equals `explicitStashDir` whenever the
  // `if` below ran, and always fails `dirExplicitlyProvided` (an immediate
  // no-op in both helpers) whenever it didn't. Removed rather than duplicated.
  if (explicitStashDir) {
    assertSetupSandbox(explicitStashDir, true);
    applyStashIsolationToEnv(explicitStashDir, true);
  }
  const current = loadUserConfig();
  const stashDir = explicitStashDir ?? primaryBundlePath(current) ?? getDefaultStashDir();

  const { config, credentials } = await applyNonInteractiveDefaults(current, stashDir, opts);

  const finalConfig = finalizeSetupDraft(config);
  validateCompleteConfig(finalConfig);
  const { precommit: initResult } = await saveSetupConfig(current, finalConfig, async () => {
    storeCredentials(credentials);
    if (opts.noInit) return undefined;
    return akmInit({ dir: stashDir, setDefault: true, persistConfig: false });
  });

  return {
    configPath: getConfigPath(),
    bundleDir: stashDir,
    stashCreated: initResult?.created ?? false,
    written: true,
    fields: Object.keys(finalConfig).filter((k) => finalConfig[k as keyof AkmConfig] !== undefined),
    runs: describeRuns(finalConfig),
  };
}

/**
 * Run ONLY environment detection and return the typed result. Performs no
 * config writes and shows no prompts.
 *
 * SAFETY: The returned object carries env var NAMES only — never any API key
 * value.
 */
export async function runDetectOnly(): Promise<DetectedEnvironment> {
  return detectEnvironment();
}

/**
 * Apply a JSON config blob non-interactively, merging it with the current config.
 * Validates required sub-fields and strips unknown/restricted keys.
 */
export async function runSetupFromConfig(opts: {
  configJson: string;
  dir?: string;
  noInit?: boolean;
  noProbe?: boolean;
  /** Flags that answer the engine questions; they apply only with `applyDefaults`. */
  flags?: EngineFlags;
  /**
   * When true (`--yes --from`), fill any keys still missing after the deep
   * merge with non-interactive defaults — without overwriting values the file
   * or existing config already supplied.
   */
  applyDefaults?: boolean;
}): Promise<SetupSummary> {
  assertSetupConfigPreflight();
  // Phase 1: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.configJson);
  } catch (e) {
    throw new UsageError(`Invalid JSON in the setup config: ${(e as Error).message}`, "INVALID_FLAG_VALUE");
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError("Setup config must contain a top-level object.", "INVALID_CONFIG_FILE");
  }
  const incoming = parsed as Partial<AkmConfig>;

  // Phase 2: Validate — only allow safe top-level keys
  for (const key of ["stashDir", "sources", "installed"] as const) {
    if (key in incoming) {
      throw new ConfigError(
        `${key} is not supported by the current config schema; configure bundles/defaultBundle instead.`,
        "INVALID_CONFIG_FILE",
      );
    }
  }
  // Derived from AkmConfigShape (via `listTopLevelConfigKeys`) rather than a
  // hand-copied set: a hand-copied allowlist silently fell out of sync as the
  // schema grew (R-017 — `index`, `search`, `feedback`, `archiveRetentionDays`,
  // `workflow`, and `experimental` were all valid schema keys that this list
  // forgot, each dropped with only a warning while the command exited 0).
  // Every key the schema recognizes is a legitimate thing to set via
  // `--from`; there is no key a user can set here that they
  // couldn't set by hand-editing config.json and letting `akm config set`
  // validate it. Keys that remain genuinely retired (`profiles`, `llm`,
  // `agent`, `features`, `stashes`, `bindings`, `writable`) are not part of
  // the schema shape, so they still fall into the warn-and-drop branch below;
  // `stashDir`/`sources`/`installed` get the more specific migration error above.
  const ALLOWED_KEYS = new Set(listTopLevelConfigKeys());
  for (const key of Object.keys(incoming)) {
    if (!ALLOWED_KEYS.has(key)) {
      warn(`[akm setup] Ignoring unknown or restricted config key: "${key}"`);
      delete (incoming as Record<string, unknown>)[key];
    }
  }

  // Phase 3: Merge with existing config
  //
  // R-066 #4 (verified, NOT reduced — unlike the `runSetupWithDefaults` pair
  // above, this one is NOT strictly redundant): the `assertSetupSandbox` +
  // `applyStashIsolationToEnv` pair below looks like a duplicate of the pair
  // here, but each guards a case the other cannot:
  //   - THIS early pair must run before `loadUserConfig()` so an explicit
  //     `--dir` pointed at a force-escaped transient sandbox isolates the
  //     config READ too, not just the later write (the isolation env var has
  //     to be set before `loadUserConfig()` executes, or `current` below is
  //     read from the host config instead of the sandboxed one — the exact
  //     failure class the "2026-05-23 setup-clobbers-user-config incident"
  //     comment on `assertSetupSandbox` describes).
  //   - The LATER pair below additionally covers a case this one can't see
  //     yet: an incoming `--from` file that names its own
  //     bundle path (`incomingPrimaryPath`) with no `--dir` at all — that
  //     path is only known after the merge, so it cannot be checked early.
  // When `explicitStashDir` is set both pairs do end up asserting the same
  // (stashDir, true), but removing either one changes behavior in the case
  // it uniquely covers, so both stay.
  const explicitStashDir = opts.dir != null ? path.resolve(opts.dir) : undefined;
  if (explicitStashDir) {
    assertSetupSandbox(explicitStashDir, true);
    applyStashIsolationToEnv(explicitStashDir, true);
  }
  const current = loadUserConfig();
  let merged = deepMergeConfig(
    current as Record<string, unknown>,
    incoming as Record<string, unknown>,
  ) as SetupDraftConfig;
  const incomingPrimaryPath = primaryBundlePath(incoming as AkmConfig);
  const configuredPrimaryPath = primaryBundlePath(merged);
  const stashDir = explicitStashDir ?? configuredPrimaryPath ?? getDefaultStashDir();

  const stashDirExplicit = explicitStashDir != null || incomingPrimaryPath !== undefined;
  assertSetupSandbox(stashDir, stashDirExplicit);
  applyStashIsolationToEnv(stashDir, stashDirExplicit);

  if (explicitStashDir !== undefined || configuredPrimaryPath === undefined) {
    merged = deepMergeConfig(merged, { primaryPath: stashDir }) as SetupDraftConfig;
  }
  // Deep-merge canonical keys: nested objects merge key-by-key so a
  // partial `--file` only updates the keys it carries and never drops sibling
  // subkeys (e.g. output.detail survives an output.format-only file). Arrays
  // and scalars replace wholesale.
  // With `--yes`, fill keys still missing after the merge with non-interactive
  // defaults. Steps start from `merged` and their nonInteractive path only
  // populates absent values, so nothing the file or existing config supplied
  // is overwritten.
  let credentials: Record<string, string> = {};
  if (opts.applyDefaults) {
    const applied = await applyNonInteractiveDefaults(merged, stashDir, opts);
    merged = applied.config;
    credentials = applied.credentials;
  }

  // Convert the private setup draft to the persisted bundle shape.
  const finalizedMerged: AkmConfig = finalizeSetupDraft(merged);

  // Reject an invalid merged config before touching the stash.
  validateCompleteConfig(finalizedMerged);
  const { precommit: initResult } = await saveSetupConfig(current, finalizedMerged, async () => {
    storeCredentials(credentials);
    if (opts.noInit) return undefined;
    return akmInit({ dir: stashDir, setDefault: true, persistConfig: false });
  });

  return {
    configPath: getConfigPath(),
    bundleDir: stashDir,
    stashCreated: initResult?.created ?? false,
    written: true,
    fields: Object.keys(incoming).filter((k) => (incoming as Record<string, unknown>)[k] !== undefined),
    runs: describeRuns(finalizedMerged),
  };
}

// ── Setup --from <file> bootstrap helper ────────────────────────────────────

/**
 * Resolve a `--from <file>` argument to a JSON-encoded config payload suitable
 * for `runSetupFromConfig({ configJson })`. Used by the CLI to bootstrap from
 * a JSON or YAML file on disk; extracted as a standalone function so its
 * filesystem and parser behaviour can be unit-tested directly.
 *
 * - Expands a leading `~` to the current user's home directory.
 * - Resolves the path against `cwd ?? process.cwd()` for relative inputs.
 * - Detects YAML vs JSON via the file extension (`.yml`/`.yaml` → YAML;
 *   anything else, including `.json`, parses as JSON).
 * - Throws `ConfigError("INVALID_CONFIG_FILE")` when the file does not exist,
 *   cannot be read, cannot be parsed, or contains a non-object top level.
 *
 * Returns `{ configJson, resolvedPath, format }` so callers can log which
 * file was actually loaded and which parser was used.
 */
export async function loadSetupConfigFromFile(
  filePath: string,
  opts?: { cwd?: string; homeDir?: string },
): Promise<{ configJson: string; resolvedPath: string; format: "json" | "yaml" }> {
  const cwd = opts?.cwd ?? process.cwd();
  const homeDir = opts?.homeDir ?? os.homedir();
  const expanded = filePath.startsWith("~") ? path.join(homeDir, filePath.slice(1)) : filePath;
  const resolvedPath = path.resolve(cwd, expanded);

  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigError(`Config file not found: ${resolvedPath}`, "INVALID_CONFIG_FILE");
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new ConfigError(
      `Failed to read config file ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  const ext = path.extname(resolvedPath).toLowerCase();
  const format: "json" | "yaml" = ext === ".yml" || ext === ".yaml" ? "yaml" : "json";
  let parsed: unknown;
  try {
    if (format === "yaml") {
      const { parse: yamlParse } = await import("yaml");
      parsed = yamlParse(raw);
    } else {
      parsed = JSON.parse(raw);
    }
  } catch (err) {
    throw new ConfigError(
      `Failed to parse ${format.toUpperCase()} config file ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `Config file ${resolvedPath} must contain a top-level object, got ${Array.isArray(parsed) ? "array" : typeof parsed}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return { configJson: JSON.stringify(parsed), resolvedPath, format };
}
