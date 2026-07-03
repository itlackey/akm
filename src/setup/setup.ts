// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Interactive configuration wizard for akm.
 *
 * Walks users through service detection, embedding/LLM setup,
 * registry selection, stash sources, and agent platform discovery.
 * Collects all choices and writes config once at the end.
 *
 * This module holds the wizard orchestration; the individual wizard steps,
 * config-shape adapters, prompt shims, provider table, and semantic-asset
 * preparation live in sibling modules (`steps/*`, `legacy-config`, `prompt`,
 * `providers`, `semantic-assets`) and are re-exported below where tests and
 * `akm init` depend on them.
 */

import { promises as dnsPromises } from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "../cli/clack";
import { akmInit, type InitResponse } from "../commands/sources/init";
import type { AkmConfig, EmbeddingConnectionConfig, LlmConnectionConfig } from "../core/config/config";
import { DEFAULT_CONFIG, getDefaultLlmConfig, loadUserConfig, saveConfig } from "../core/config/config";
import { backupExistingConfig } from "../core/config/config-io";
import { deepMergeConfig } from "../core/deep-merge";
import { ConfigError, UsageError } from "../core/errors";
import { getConfigPath, getDefaultStashDir, isTransientStashPath } from "../core/paths";
import { warn } from "../core/warn";
import { akmIndex } from "../indexer/indexer";
import {
  clearSemanticStatus,
  deriveSemanticProviderFingerprint,
  writeSemanticStatus,
} from "../indexer/search/semantic-status";
import { detectAgentCliProfiles, pickDefaultAgentProfile } from "../integrations/agent";
import { defaultProfileName } from "../integrations/harnesses";
import { probeLlmCapabilities } from "../llm/client";
import { getOutputMode } from "../output/context";
import {
  type DetectedEnvironment,
  detectEnvironment,
  detectLMStudio,
  type LMStudioDetectionResult,
  renderDetectionSummary,
} from "./detect";
import { detectHarnessConfigs } from "./harness-config-import";
import { applyLegacyAgent, applyLegacyLlm, type LegacyAgentBlockShape } from "./legacy-config";
import { bail, prompt } from "./prompt";
import { PROVIDER_DEFAULTS } from "./providers";
import { prepareSemanticSearchAssets } from "./semantic-assets";
import { createSetupContext, runSetupSteps, type SetupStep } from "./steps";
import { stepAgentConnection, stepLlm, stepOllama, stepSmallModelConnection } from "./steps/connection";
import { stepOutputConfig } from "./steps/output";
import {
  printCapabilitySummary,
  stepAgentCliDetection,
  stepAgentPlatforms,
  stepAgentSelection,
} from "./steps/platforms";
import { stepSemanticSearch } from "./steps/semantic";
import { stepAdditionalSources, stepAddSources, stepRegistries } from "./steps/sources";
import { stepStashDir } from "./steps/stashdir";
import { stepDefaultImproveTasks, stepScheduledTasks } from "./steps/tasks";

// Re-export the extracted step functions + helpers so `../setup/setup` remains
// the stable public surface for tests and `akm init`.
export { onCancel } from "./prompt";
export { describeSemanticSearchAssets } from "./semantic-assets";
export type { SmallModelConnectionResult } from "./steps/connection";
export { stepAgentConnection, stepLlm, stepSmallModelConnection } from "./steps/connection";
export { stepOutputConfig } from "./steps/output";
export type { AgentSetupResult } from "./steps/platforms";
export { stepAgentCliDetection, stepAgentSelection } from "./steps/platforms";
export { stepSemanticSearch } from "./steps/semantic";
export { stepAddSources, stepRegistries } from "./steps/sources";
export type { ScheduledTasksDeps } from "./steps/tasks";
export { stepDefaultImproveTasks, stepScheduledTasks } from "./steps/tasks";

// ── Setup sandbox guard ─────────────────────────────────────────────────────

/**
 * Refuse to persist an explicit `--dir /tmp/...` stashDir to the user's
 * config. The OS may reap the directory at any time, and the next run will
 * see a `stashDir` that points at a deleted path (falling back to ~/akm
 * silently). Mirrors the `assertInitSandbox` check in commands/init.ts, but
 * fires under all runtimes (not just `bun test`) because `akm setup --dir
 * /tmp/X` is a documented isolation pattern that has been observed to
 * silently clobber the host config — see
 * `docs/technical/incidents/2026-05-23-setup-clobbers-user-config.md`.
 *
 * Escape hatch: set `AKM_FORCE_SETUP_TMP_STASH=1` to override. When the
 * escape hatch is on, `applyStashIsolationToEnv` below also pre-sets
 * `AKM_STASH_DIR` so that the `getConfigDir` / `getCacheDir` isolation
 * rules fire and config + cache writes route into `$stashDir/.akm/`
 * instead of the user's host `~/.config/akm`.
 */
function assertSetupSandbox(stashDir: string, dirExplicitlyProvided: boolean): void {
  if (!dirExplicitlyProvided) return;
  if (process.env.AKM_FORCE_SETUP_TMP_STASH === "1") return;
  if (!isTransientStashPath(stashDir)) return;
  throw new ConfigError(
    `refusing to run \`akm setup --dir ${stashDir}\`: the path is in a transient/sandbox directory family the OS may reap. ` +
      "Persisting it as the user's stashDir would leave the next run pointing at a deleted path (silently falling back to ~/akm). " +
      "Use a persistent directory, OR set AKM_FORCE_SETUP_TMP_STASH=1 if you intentionally want a sandbox setup " +
      "(setup will also auto-isolate config + cache writes into $stashDir/.akm/ so the host config is preserved).",
    "SETUP_TMP_STASH_REFUSED",
  );
}

/**
 * Propagate the explicit `--dir <stashDir>` choice to the env so that the
 * `getConfigDir` / `getCacheDir` isolation rules in `src/core/paths.ts`
 * actually fire for the duration of this setup run. Without this, a CLI
 * caller who passes `--dir /tmp/X` but doesn't pre-export `AKM_STASH_DIR`
 * would still write config to the host `~/.config/akm/config.json`. We
 * only set the env var when:
 *   - `--dir` was explicitly provided (we have an operator-stated stash), AND
 *   - `AKM_STASH_DIR` is not already set (caller's explicit env wins).
 * The set is process-wide; for the CLI that's the right scope (the process
 * is about to do all its work against this stash). For tests, each test
 * already isolates env via beforeEach/afterEach so there is no leak.
 */
function applyStashIsolationToEnv(stashDir: string, dirExplicitlyProvided: boolean): void {
  if (!dirExplicitlyProvided) return;
  if (process.env.AKM_STASH_DIR?.trim()) return;
  process.env.AKM_STASH_DIR = stashDir;
}

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SetupSummary {
  configPath: string;
  stashDir: string;
  stashCreated: boolean;
  written: boolean;
  fields: string[];
  ripgrep?: InitResponse["ripgrep"];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Quick connectivity check. Returns true if we can resolve a hostname
 * the user has already implicitly trusted within 3 seconds, false
 * otherwise. Used to skip network-dependent setup steps gracefully
 * when offline.
 *
 * We use a DNS lookup against `github.com` rather than an HTTP request
 * because (1) it doesn't actually send a request to anyone we aren't
 * already talking to (the user got akm from GitHub and `akm upgrade`
 * polls api.github.com), and (2) DNS is the right layer for "do we have
 * working network" without making the user opt into yet another remote.
 * The previous implementation pinged https://dns.google which
 * contradicted the spirit of "no remote endpoints akm doesn't own."
 *
 * @internal Exported for testing only.
 */
export async function isOnline(): Promise<boolean> {
  try {
    await Promise.race([
      dnsPromises.lookup("github.com"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dns lookup timed out")), 3000).unref()),
    ]);
    return true;
  } catch {
    return false;
  }
}

// ── Main Wizard ─────────────────────────────────────────────────────────────

/**
 * Build the canonical list of `SetupStep`s for the interactive wizard.
 * Exposed (and exported) so tests and `akm init` can compose subsets.
 *
 * Each step wraps the existing `step*` functions, accumulating its result
 * into the shared `SetupContext`. The `nonInteractive` flag controls
 * inclusion in `akm init` (a non-interactive preset of `akm setup`).
 */
export function buildSetupSteps(options: {
  online: boolean;
  semanticSearchOutcome: { mode: "off" | "auto"; prepareAssets: boolean };
  preferredStashDir?: string;
  detection?: DetectedEnvironment;
}): {
  steps: SetupStep[];
  /** Latest semantic-search choice; populated by the semantic-search step. */
  outcome: { semantic: { mode: "off" | "auto"; prepareAssets: boolean } };
} {
  const outcome = { semantic: options.semanticSearchOutcome };
  // Local cache of Ollama-detected fields surfaced from the embedding step
  // to the LLM step. Mutable by design — `stepLlm` needs them.
  let ollamaEndpoint: string | undefined;
  let ollamaChatModels: string[] | undefined;
  let lmStudioResult: LMStudioDetectionResult | undefined;
  // Harness configs detected once and shared with the LLM step. Reuse the
  // aggregate detection's harness configs when available so we detect once.
  const harnessConfigs = options.detection?.harnessConfigs ?? detectHarnessConfigs();

  const steps: SetupStep[] = [
    {
      id: "stash-dir",
      label: "Stash Directory",
      nonInteractive: true,
      async run(ctx) {
        const stashDir = await stepStashDir(ctx.config, {
          nonInteractive: ctx.nonInteractive,
          preferredDir: options.preferredStashDir,
        });
        ctx.apply({ stashDir });
      },
    },
    {
      id: "embedding",
      label: "Embedding",
      async run(ctx) {
        if (!options.online) {
          ctx.apply({ embedding: ctx.config.embedding });
          return;
        }
        const [result, lmStudio] = await Promise.all([stepOllama(ctx.config), detectLMStudio()]);
        ollamaEndpoint = result.ollamaEndpoint;
        ollamaChatModels = result.ollamaChatModels;
        lmStudioResult = lmStudio;
        ctx.apply({ embedding: result.embedding });
      },
    },
    {
      id: "llm",
      label: "LLM Provider",
      async run(ctx) {
        if (!options.online) {
          return;
        }
        const llm = await stepLlm(ctx.config, ollamaEndpoint, ollamaChatModels, lmStudioResult, harnessConfigs);
        ctx.apply(applyLegacyLlm(ctx.config, llm));
      },
    },
    {
      id: "semantic-search",
      label: "Semantic Search",
      async run(ctx) {
        const semantic = await stepSemanticSearch(ctx.config, ctx.config.embedding);
        outcome.semantic = semantic;
        ctx.apply({ semanticSearchMode: semantic.mode });
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
      label: "Stash Sources",
      async run(ctx) {
        const stashes = await stepAddSources(ctx.config, { promptForAdditional: false });
        const platforms = await stepAgentPlatforms({ ...ctx.config, sources: stashes });
        const merged = [...stashes];
        for (const ps of platforms) {
          if (!merged.some((s) => s.path === ps.path)) merged.push(ps);
        }
        const withAdditional = await stepAdditionalSources(merged);
        ctx.apply({ sources: withAdditional.length > 0 ? withAdditional : undefined });
      },
    },
    {
      id: "agent-cli",
      label: "Agent CLI",
      async run(ctx) {
        const result = stepAgentCliDetection(ctx.config);
        const detected = result.detections.filter((d) => d.available);
        if (detected.length > 0) {
          p.log.info(
            `Detected agent CLIs: ${detected.map((d) => d.name).join(", ")}.` +
              (result.agent?.default ? ` Default profile: ${result.agent.default}.` : ""),
          );
        } else {
          p.log.info(
            "No agent CLIs detected on PATH. Agent commands will be disabled until one is installed and `akm setup` is re-run.",
          );
        }
        // Inject the detected agent block into a synthetic AkmConfig so
        // stepAgentSelection can read it via getCurrentAgentBlock().
        const synthConfig = { ...ctx.config, ...applyLegacyAgent(ctx.config, result.agent) };
        const agent = await stepAgentSelection(synthConfig, result.detections);
        ctx.apply(applyLegacyAgent(ctx.config, agent));
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
    {
      id: "scheduled-tasks",
      label: "Scheduled Tasks",
      // Interactive-only: `akm init` / `--yes` skip this step so headless
      // runs never enable a scheduled task (see issue #512).
      async run() {
        await stepDefaultImproveTasks();
        await stepScheduledTasks();
      },
    },
  ];

  return { steps, outcome };
}

export async function runSetupWizard(opts?: { dir?: string; noInit?: boolean }): Promise<void> {
  p.intro("akm setup");

  const current = loadUserConfig();
  const configPath = getConfigPath();

  // Resolve stash directory early so akmInit can run before any prompts
  const resolvedStashDir = opts?.dir ? path.resolve(opts.dir) : (current.stashDir ?? getDefaultStashDir());

  // Refuse explicit --dir /tmp/... before doing any work — protects the host
  // config from being clobbered with a stashDir that the OS may reap.
  assertSetupSandbox(resolvedStashDir, opts?.dir != null);
  applyStashIsolationToEnv(resolvedStashDir, opts?.dir != null);

  // Bootstrap directory structure before any prompts so the stash exists
  // even if the wizard is interrupted after this point.
  if (!opts?.noInit) {
    await akmInit({ dir: resolvedStashDir, setDefault: true });
  }

  // Quick connectivity check — skip network-dependent steps when offline
  const online = await isOnline();
  if (!online) {
    p.log.warn(
      "No network connectivity detected. Skipping Ollama detection and remote embedding checks.\n" +
        "Local-only setup will continue. Re-run `akm setup` when online for full configuration.",
    );
  }

  // Aggregate environment detection — run once before any prompt and surface
  // a summary so the user sees what was auto-detected. NAMES only, never
  // API key values.
  const detection = await detectEnvironment({ existingStashDir: current.stashDir });
  p.note(renderDetectionSummary(detection), "Detected environment");

  // Interactive entry point for `--reset-recommended`: offer to apply the
  // opinionated, detection-derived defaults and skip the step-by-step wizard.
  const useRecommended = await prompt(() =>
    p.confirm({
      message: "Apply recommended defaults from the detected environment (merged into your existing config)?",
      initialValue: false,
    }),
  );
  if (useRecommended) {
    const result = await runResetRecommended({ dir: opts?.dir, noInit: opts?.noInit });
    p.outro(`Recommended configuration saved to ${result.configPath}`);
    return;
  }

  const ctx = createSetupContext(current, { nonInteractive: false });
  const { steps, outcome } = buildSetupSteps({
    online,
    semanticSearchOutcome: { mode: current.semanticSearchMode, prepareAssets: false },
    preferredStashDir: resolvedStashDir,
    detection,
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

  // ── Two-step connection configuration ──────────────────────────────────────
  // Step 1/2: Small model connection (for enrichment features)
  const smallModelResult = await stepSmallModelConnection(ctx.config);
  if (!smallModelResult.skipped) {
    ctx.apply(applyLegacyLlm(ctx.config, smallModelResult.llm));
  }

  // Step 2/2: Agent connection (for agentic features)
  const agentConfig = await stepAgentConnection(ctx.config, smallModelResult);
  ctx.apply(applyLegacyAgent(ctx.config, agentConfig));

  const newConfig: AkmConfig = {
    ...ctx.config,
    // Preserve fields the steps don't manage explicitly.
    installed: current.installed,
  };
  const semanticSearchMode = outcome.semantic;
  const stashDir = newConfig.stashDir ?? current.stashDir ?? getDefaultStashDir();
  const embedding = newConfig.embedding;
  const llm = getDefaultLlmConfig(newConfig);
  const registries = newConfig.registries;
  const allStashes = newConfig.sources ?? [];

  // Feature capability summary
  const agentConfigured = Boolean(agentConfig);
  printCapabilitySummary(smallModelResult.skipped, agentConfigured);

  // Confirm before saving
  const effectiveRegistries = registries ?? DEFAULT_CONFIG.registries ?? [];
  p.note(
    [
      `Stash directory:  ${stashDir}`,
      `Embedding:        ${embedding ? `${embedding.provider ?? "remote"} / ${embedding.model}` : "built-in local"}`,
      `LLM:              ${llm ? `${llm.provider ?? "remote"} / ${llm.model}` : "disabled"}`,
      `Semantic search:  ${semanticSearchMode.mode}`,
      `Registries:       ${effectiveRegistries.filter((r) => r.enabled !== false).length} enabled`,
      `Stash sources:    ${allStashes.length}`,
      `Agent default:    ${newConfig.defaults?.agent ?? "disabled"}`,
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

  // Save config
  const cfgPath1 = getConfigPath();
  backupAndAnnounce(cfgPath1);
  saveConfig(newConfig);

  if (semanticSearchMode.mode === "off") {
    clearSemanticStatus();
  }

  if (semanticSearchMode.mode === "auto") {
    if (semanticSearchMode.prepareAssets) {
      const ready = await prepareSemanticSearchAssets(newConfig);
      if (!ready.ok) {
        writeSemanticStatus({
          status: "blocked",
          reason: ready.reason as never,
          message: ready.message,
          providerFingerprint: deriveSemanticProviderFingerprint(newConfig.embedding),
          lastCheckedAt: new Date().toISOString(),
        });
        p.log.warn(
          "Semantic search remains set to auto, but is currently blocked. Re-run `akm index --full --verbose` once the issue is resolved.",
        );
      } else {
        writeSemanticStatus({
          status: "pending",
          message: "Semantic prerequisites verified. Building the index to finish activation.",
          providerFingerprint: deriveSemanticProviderFingerprint(newConfig.embedding),
          lastCheckedAt: new Date().toISOString(),
        });
      }
    } else {
      writeSemanticStatus({
        status: "pending",
        message: "Semantic search is enabled, but asset preparation was skipped.",
        providerFingerprint: deriveSemanticProviderFingerprint(newConfig.embedding),
        lastCheckedAt: new Date().toISOString(),
      });
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
    if (newConfig.semanticSearchMode === "auto") {
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
    if (newConfig.semanticSearchMode === "auto") {
      writeSemanticStatus({
        status: "blocked",
        reason: "index-failed",
        message: String(err),
        providerFingerprint: deriveSemanticProviderFingerprint(newConfig.embedding),
        lastCheckedAt: new Date().toISOString(),
      });
    }
  }

  // API key reminder
  if (embedding?.apiKey === undefined && embedding?.provider !== "ollama") {
    // Only remind about API keys for non-Ollama remote providers
    if (embedding?.endpoint && !embedding.endpoint.includes("localhost")) {
      p.log.info("Reminder: Set your embedding API key via the AKM_EMBED_API_KEY environment variable.");
    }
  }
  if (llm?.apiKey === undefined && llm?.provider !== "ollama") {
    if (llm?.endpoint && !llm.endpoint.includes("localhost")) {
      p.log.info("Reminder: Set your LLM API key via the AKM_LLM_API_KEY environment variable.");
    }
  }

  p.outro(`Configuration saved to ${configPath}`);
}

// ── Non-interactive / scripting entry points ─────────────────────────────────

/**
 * Back up an existing config file and print the real, timestamped backup
 * location (not a generic display string). On a fresh install where there is
 * nothing to back up, print a "nothing to back up" notice instead.
 */
function backupAndAnnounce(configPath: string): void {
  const result = backupExistingConfig(configPath);
  const message = result ? `Config backed up to ${result.timestamped}` : "No existing config to back up.";
  // In JSON output mode the structured envelope (which already carries
  // `configPath`) MUST be the only thing on stdout — `setup --yes | jq` is a
  // supported scripting contract. @clack's `p.log.info` writes to stdout, which
  // would corrupt that envelope, so route this human-progress notice to stderr
  // when emitting JSON. Interactive/text runs keep the inline clack banner.
  if (isJsonOutputMode()) {
    process.stderr.write(`${message}\n`);
  } else {
    p.log.info(message);
  }
}

/**
 * True when the process-level output mode is JSON (the default machine format).
 * Defensive: setup is also invoked programmatically (tests) where the output
 * mode singleton may not be initialized — treat that as "not JSON" so the
 * human-readable clack banner is used.
 */
function isJsonOutputMode(): boolean {
  try {
    return getOutputMode().format === "json";
  } catch {
    return false;
  }
}

/**
 * Run setup in non-interactive mode, applying all defaults.
 * Safe to call from CI or scripts. Idempotent — re-running produces the same result.
 */
export async function runSetupWithDefaults(opts: {
  dir?: string;
  noInit?: boolean;
  probe?: boolean;
}): Promise<SetupSummary> {
  const current = loadUserConfig();
  const stashDir = opts.dir ? path.resolve(opts.dir) : (current.stashDir ?? getDefaultStashDir());

  assertSetupSandbox(stashDir, opts.dir != null);
  applyStashIsolationToEnv(stashDir, opts.dir != null);

  // Bootstrap directory structure first
  let initResult: InitResponse | undefined;
  if (!opts.noInit) {
    initResult = await akmInit({ dir: stashDir, setDefault: true });
  }

  // Run steps in non-interactive mode (applies defaults, skips prompts)
  const ctx = createSetupContext(current, { nonInteractive: true });
  const { steps } = buildSetupSteps({
    online: false,
    semanticSearchOutcome: { mode: current.semanticSearchMode, prepareAssets: false },
    preferredStashDir: stashDir,
  });
  await runSetupSteps(steps, ctx);

  // Ensure stashDir is set
  if (!ctx.config.stashDir) ctx.apply({ stashDir });

  // Aggregate environment detection — apply detected values directly.
  const env = await detectEnvironment({ existingStashDir: ctx.config.stashDir });

  // Apply a detected LLM (live local server) when the config has none yet.
  if (!getDefaultLlmConfig(ctx.config)) {
    const liveLocal = env.localServers.find((s) => s.available && s.defaultModel);
    if (liveLocal?.defaultModel) {
      const llm: LlmConnectionConfig = {
        provider: "local",
        endpoint: `${liveLocal.baseUrl.replace(/\/$/, "")}/v1`,
        model: liveLocal.defaultModel,
      };
      // A required field being unresolvable must fail loudly rather than write
      // a broken config (--yes acceptance criterion).
      if (!llm.endpoint?.trim() || !llm.model?.trim()) {
        throw new UsageError(
          "Detected a local LLM server but could not resolve a required field (endpoint/model). Re-run `akm setup` interactively.",
          "MISSING_REQUIRED_ARGUMENT",
        );
      }
      ctx.apply(applyLegacyLlm(ctx.config, llm));
    }
  }

  // Auto-detect agent CLI if not already configured
  if (!ctx.config.defaults?.agent) {
    let defaultProfile: string | undefined;
    if (env.harness !== "none") {
      defaultProfile = env.harness;
    } else {
      const detected = detectAgentCliProfiles(undefined);
      defaultProfile = pickDefaultAgentProfile(detected, undefined);
    }
    if (defaultProfile) {
      ctx.apply(applyLegacyAgent(ctx.config, { default: defaultProfile }));
    }
  }

  const cfgPath2 = getConfigPath();
  backupAndAnnounce(cfgPath2);
  saveConfig(ctx.config);

  return {
    configPath: getConfigPath(),
    stashDir,
    stashCreated: initResult?.created ?? false,
    written: true,
    fields: Object.keys(ctx.config).filter((k) => ctx.config[k as keyof AkmConfig] !== undefined),
    ripgrep: initResult?.ripgrep,
  };
}

/**
 * Run ONLY environment detection and return the typed result. Performs no
 * config writes and shows no prompts. Backs `akm setup --detect-only`.
 *
 * SAFETY: The returned object carries env var NAMES only — never any API key
 * value.
 */
export async function runDetectOnly(): Promise<DetectedEnvironment> {
  const current = loadUserConfig();
  return detectEnvironment({ existingStashDir: current.stashDir });
}

/**
 * Derive opinionated defaults from a detection result.
 *
 * - Best harness → agent default (when a profile maps to it).
 * - Fastest live local model, else the first detected cloud key's provider.
 * - `nomic-embed-text` embeddings when a local LLM is live.
 * - improve task `0 2 * * *`, index task `0 4 * * *`.
 *
 * Returns a partial `AkmConfig`-shaped object plus a legacy `llm` block, ready
 * to merge. Never includes an API key value.
 */
export function deriveRecommendedConfig(env: DetectedEnvironment): {
  llm?: LlmConnectionConfig;
  embedding?: EmbeddingConnectionConfig;
  agentDefault?: string;
  taskSchedules?: { improve?: string; index?: string };
} {
  const result: ReturnType<typeof deriveRecommendedConfig> = {};

  // Best harness → agent default. #566: derive the default profile name from
  // the harness registry instead of a hardcoded if-chain, so a newly added
  // dispatch-capable harness gets a usable headless default (its canonical id)
  // automatically. "none" / unknown ids resolve to undefined (no default).
  const agentDefault = defaultProfileName(env.harness);
  if (agentDefault) result.agentDefault = agentDefault;

  // LLM: prefer a live local server, else a detected cloud provider key.
  const liveLocal = env.localServers.find((s) => s.available && s.defaultModel);
  if (liveLocal?.defaultModel) {
    result.llm = {
      provider: "local",
      endpoint: `${liveLocal.baseUrl.replace(/\/$/, "")}/v1`,
      model: liveLocal.defaultModel,
    };
    // Local LLM live → use a local embedding model.
    result.embedding = { provider: "ollama", model: "nomic-embed-text", endpoint: `${liveLocal.baseUrl}/v1` };
  } else {
    // Map a detected cloud API-key provider to an llm endpoint. NAMES only —
    // the value lives in the env var the user already set; we never read it.
    const cloud = env.providers.find((pr) => pr.kind === "apiKey");
    if (cloud) {
      const defaults = PROVIDER_DEFAULTS[cloud.provider];
      if (defaults) {
        result.llm = { provider: cloud.provider, endpoint: defaults.endpoint, model: defaults.model };
      }
    }
  }

  result.taskSchedules = { improve: "0 2 * * *", index: "0 4 * * *" };

  return result;
}

/**
 * `akm setup --reset-recommended`: merge opinionated, detection-derived
 * defaults into the existing config WITHOUT removing pre-existing custom keys.
 * Uses the same merge path as {@link runSetupFromConfig} so custom keys survive
 * (follows #511 semantics).
 */
export async function runResetRecommended(opts: {
  dir?: string;
  noInit?: boolean;
  probe?: boolean;
}): Promise<SetupSummary> {
  const current = loadUserConfig();
  const env = await detectEnvironment({ existingStashDir: current.stashDir });
  const recommended = deriveRecommendedConfig(env);

  const incoming: Partial<AkmConfig> & { llm?: LlmConnectionConfig; agent?: LegacyAgentBlockShape } = {};
  if (recommended.llm) incoming.llm = recommended.llm;
  if (recommended.embedding) incoming.embedding = recommended.embedding;
  if (recommended.agentDefault) incoming.agent = { default: recommended.agentDefault };
  if (recommended.taskSchedules) {
    (incoming as Record<string, unknown>).setup = { taskSchedules: recommended.taskSchedules };
  }

  return runSetupFromConfig({
    configJson: JSON.stringify(incoming),
    dir: opts.dir,
    noInit: opts.noInit,
    probe: opts.probe,
  });
}

/**
 * Apply a JSON config blob non-interactively, merging it with the current config.
 * Validates required sub-fields and strips unknown/restricted keys.
 */
export async function runSetupFromConfig(opts: {
  configJson: string;
  dir?: string;
  noInit?: boolean;
  probe?: boolean;
  /**
   * When true (`--yes --file`), fill any keys still missing after the deep
   * merge with non-interactive defaults — without overwriting values the file
   * or existing config already supplied.
   */
  applyDefaults?: boolean;
}): Promise<SetupSummary> {
  // Phase 1: Parse JSON
  type IncomingShape = Partial<AkmConfig> & {
    llm?: LlmConnectionConfig;
    agent?: LegacyAgentBlockShape;
  };
  let incoming: IncomingShape;
  try {
    incoming = JSON.parse(opts.configJson);
  } catch (e) {
    throw new Error(`Invalid JSON in --config: ${(e as Error).message}`);
  }

  // Phase 2: Validate — only allow safe top-level keys
  const ALLOWED_KEYS = new Set([
    "stashDir",
    "llm",
    "embedding",
    "agent",
    "semanticSearchMode",
    "output",
    "profiles",
    "defaults",
    "setup",
  ]);
  for (const key of Object.keys(incoming)) {
    if (!ALLOWED_KEYS.has(key)) {
      warn(`[akm setup] Ignoring unknown or restricted config key: "${key}"`);
      delete (incoming as Record<string, unknown>)[key];
    }
  }

  // Validate required sub-fields
  if (incoming.llm) {
    if (!incoming.llm.endpoint?.trim()) throw new Error("llm.endpoint is required when llm is provided");
    if (!incoming.llm.model?.trim()) throw new Error("llm.model is required when llm is provided");
  }
  if (incoming.embedding) {
    if (!incoming.embedding.endpoint?.trim())
      throw new Error("embedding.endpoint is required when embedding is provided");
    if (!incoming.embedding.model?.trim()) throw new Error("embedding.model is required when embedding is provided");
  }

  // Phase 3: Merge with existing config
  const current = loadUserConfig();
  const stashDir = opts.dir
    ? path.resolve(opts.dir)
    : incoming.stashDir
      ? path.resolve(incoming.stashDir)
      : (current.stashDir ?? getDefaultStashDir());

  const stashDirExplicit = opts.dir != null || incoming.stashDir != null;
  assertSetupSandbox(stashDir, stashDirExplicit);
  applyStashIsolationToEnv(stashDir, stashDirExplicit);

  let merged: AkmConfig = { ...current, stashDir };
  // Deep-merge non-llm/agent keys: nested objects merge key-by-key so a
  // partial `--file` only updates the keys it carries and never drops sibling
  // subkeys (e.g. output.detail survives an output.format-only file). Arrays
  // and scalars replace wholesale.
  for (const key of Object.keys(incoming)) {
    if (key === "llm" || key === "agent") continue;
    const incomingVal = (incoming as Record<string, unknown>)[key];
    const mergedRec = merged as unknown as Record<string, unknown>;
    mergedRec[key] = deepMergeConfig(mergedRec[key], incomingVal);
  }
  // Translate legacy llm/agent inputs into the new shape.
  if (incoming.llm) {
    merged = { ...merged, ...applyLegacyLlm(merged, incoming.llm) };
  }
  if (incoming.agent) {
    merged = { ...merged, ...applyLegacyAgent(merged, incoming.agent) };
  }

  // With `--yes`, fill keys still missing after the merge with non-interactive
  // defaults. Steps start from `merged` and their nonInteractive path only
  // populates absent values, so nothing the file or existing config supplied
  // is overwritten.
  if (opts.applyDefaults) {
    const ctx = createSetupContext(merged, { nonInteractive: true });
    const { steps } = buildSetupSteps({
      online: false,
      semanticSearchOutcome: { mode: merged.semanticSearchMode, prepareAssets: false },
      preferredStashDir: stashDir,
    });
    await runSetupSteps(steps, ctx);
    if (!ctx.config.stashDir) ctx.apply({ stashDir });
    if (!ctx.config.defaults?.agent) {
      const detected = detectAgentCliProfiles(undefined);
      const defaultProfile = pickDefaultAgentProfile(detected, undefined);
      if (defaultProfile) {
        ctx.apply(applyLegacyAgent(ctx.config, { default: defaultProfile }));
      }
    }
    merged = ctx.config;
  }

  // Bootstrap directory structure
  let initResult: InitResponse | undefined;
  if (!opts.noInit) {
    initResult = await akmInit({ dir: stashDir, setDefault: true });
  }

  // Optional probe
  const mergedLlm = getDefaultLlmConfig(merged);
  if (opts.probe && mergedLlm) {
    try {
      const caps = await probeLlmCapabilities(mergedLlm);
      if (caps.reachable) {
        merged = {
          ...merged,
          ...applyLegacyLlm(merged, {
            ...mergedLlm,
            capabilities: { structuredOutput: caps.structuredOutput ?? false },
          }),
        };
      }
    } catch {
      // Non-fatal: probe failure is informational only
    }
  }

  const cfgPath3 = getConfigPath();
  backupAndAnnounce(cfgPath3);
  saveConfig(merged);

  return {
    configPath: getConfigPath(),
    stashDir,
    stashCreated: initResult?.created ?? false,
    written: true,
    fields: Object.keys(incoming).filter((k) => (incoming as Record<string, unknown>)[k] !== undefined),
    ripgrep: initResult?.ripgrep,
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
