import fs from "node:fs";
import path from "node:path";
import { stripJsonComments } from "../core/config";
import { getCacheDir, getConfigPath } from "../core/paths";
import { warn } from "../core/warn";

const PROJECT_CONFIG_RELATIVE_PATH = path.join(".akm", "config.json");

function backupConfigFile(configPath: string): void {
  if (!fs.existsSync(configPath)) return;
  const backupDir = path.join(getCacheDir(), "config-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const backupPath = path.join(backupDir, `config-${timestamp}.json`);
  fs.copyFileSync(configPath, backupPath);
  const latestPath = path.join(backupDir, "config.latest.json");
  fs.copyFileSync(configPath, latestPath);
}

function acquireMigrateLock(lockPath: string, noWait: boolean): (() => void) | null {
  const lockDir = path.dirname(lockPath);
  fs.mkdirSync(lockDir, { recursive: true });

  const maxAttempts = noWait ? 1 : 20;
  const delayMs = 200;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      };
    } catch {
      if (noWait) {
        return null;
      }
      // Simple busy-wait — synchronous since this is a one-shot CLI action
      const deadline = Date.now() + delayMs;
      while (Date.now() < deadline) {
        // spin
      }
    }
  }
  return null;
}

function stripSdkModeFromProfiles(profiles: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (typeof profile === "object" && profile !== null && !Array.isArray(profile)) {
      const { sdkMode: _sdkMode, ...rest } = profile as Record<string, unknown>;
      result[name] = rest;
    } else {
      result[name] = profile;
    }
  }
  return result;
}

export function migrateConfigShape(raw: Record<string, unknown>): {
  changed: boolean;
  result: Record<string, unknown>;
} {
  // Already migrated
  if (
    (typeof raw.configVersion === "number" && raw.configVersion >= 2) ||
    (typeof raw.configVersion === "string" && raw.configVersion.trim() !== "")
  ) {
    return { changed: false, result: raw };
  }

  const result: Record<string, unknown> = { ...raw };
  let changed = false;

  // Ensure features tree exists
  const features = (
    typeof result.features === "object" && result.features !== null && !Array.isArray(result.features)
      ? { ...(result.features as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  const featuresImprove = (
    typeof features.improve === "object" && features.improve !== null && !Array.isArray(features.improve)
      ? { ...(features.improve as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  const featuresIndex = (
    typeof features.index === "object" && features.index !== null && !Array.isArray(features.index)
      ? { ...(features.index as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  const featuresSearch = (
    typeof features.search === "object" && features.search !== null && !Array.isArray(features.search)
      ? { ...(features.search as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  // Migrate config.llm.features.*
  if (typeof raw.llm === "object" && raw.llm !== null && !Array.isArray(raw.llm)) {
    const llm = raw.llm as Record<string, unknown>;
    if (typeof llm.features === "object" && llm.features !== null && !Array.isArray(llm.features)) {
      const llmFeatures = llm.features as Record<string, boolean>;

      const indexKeys = ["memory_inference", "graph_extraction", "metadata_enhance"] as const;
      for (const key of indexKeys) {
        if (key in llmFeatures) {
          featuresIndex[key] = llmFeatures[key];
          changed = true;
        }
      }

      const improveKeys = ["memory_consolidation", "feedback_distillation"] as const;
      for (const key of improveKeys) {
        if (key in llmFeatures) {
          featuresImprove[key] = llmFeatures[key];
          changed = true;
        }
      }

      if ("curate_rerank" in llmFeatures) {
        featuresSearch.curate_rerank = llmFeatures.curate_rerank;
        changed = true;
      }

      // Strip the old features block from llm
      const { features: _features, ...llmRest } = llm;
      result.llm = llmRest;
      changed = true;
    }
  }

  // Ensure defaults tree
  const defaults = (
    typeof result.defaults === "object" && result.defaults !== null && !Array.isArray(result.defaults)
      ? { ...(result.defaults as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  const defaultsImprove = (
    typeof defaults.improve === "object" && defaults.improve !== null && !Array.isArray(defaults.improve)
      ? { ...(defaults.improve as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  // Migrate config.improve.*
  if (typeof raw.improve === "object" && raw.improve !== null && !Array.isArray(raw.improve)) {
    const improve = raw.improve as Record<string, unknown>;

    if (typeof improve.reflectCooldownByType === "object" && improve.reflectCooldownByType !== null) {
      // Move to features.improve.reflect.options.cooldown
      const existingReflect =
        typeof featuresImprove.reflect === "object" &&
        featuresImprove.reflect !== null &&
        !Array.isArray(featuresImprove.reflect)
          ? { ...(featuresImprove.reflect as Record<string, unknown>) }
          : ({} as Record<string, unknown>);
      const existingOptions =
        typeof existingReflect.options === "object" &&
        existingReflect.options !== null &&
        !Array.isArray(existingReflect.options)
          ? { ...(existingReflect.options as Record<string, unknown>) }
          : ({} as Record<string, unknown>);

      existingOptions.cooldown = improve.reflectCooldownByType;
      existingReflect.options = existingOptions;
      featuresImprove.reflect = existingReflect;
      changed = true;
    }

    if (typeof improve.limit === "number") {
      defaultsImprove.limit = improve.limit;
      changed = true;
    }

    // Strip schedule, keep rest
    const { reflectCooldownByType: _rct, limit: _limit, schedule: _schedule, ...improveRest } = improve;
    if (Object.keys(improveRest).length > 0) {
      result.improve = improveRest;
    } else {
      delete result.improve;
    }
    if (changed) {
      // Update defaults
      if (Object.keys(defaultsImprove).length > 0) {
        defaults.improve = defaultsImprove;
        result.defaults = defaults;
      }
    }
  }

  // Strip config.agent.processes["task"] and sdkMode from any profiles
  if (typeof result.agent === "object" && result.agent !== null && !Array.isArray(result.agent)) {
    const agent = { ...(result.agent as Record<string, unknown>) };

    if (typeof agent.processes === "object" && agent.processes !== null && !Array.isArray(agent.processes)) {
      const { task: _task, ...processesRest } = agent.processes as Record<string, unknown>;
      if (Object.keys(processesRest).length > 0) {
        agent.processes = processesRest;
      } else {
        delete agent.processes;
      }
      changed = true;
    }

    if (typeof agent.profiles === "object" && agent.profiles !== null && !Array.isArray(agent.profiles)) {
      agent.profiles = stripSdkModeFromProfiles(agent.profiles as Record<string, unknown>);
      changed = true;
    }

    result.agent = agent;
  }

  // Assemble features
  const newFeatures: Record<string, unknown> = {};
  if (Object.keys(featuresImprove).length > 0) newFeatures.improve = featuresImprove;
  if (Object.keys(featuresIndex).length > 0) newFeatures.index = featuresIndex;
  if (Object.keys(featuresSearch).length > 0) newFeatures.search = featuresSearch;
  if (Object.keys(newFeatures).length > 0) {
    result.features = newFeatures;
    changed = true;
  }

  if (changed) {
    result.configVersion = "0.8.0";
  }

  return { changed, result };
}

export async function migrateConfigFile(
  filePath: string,
  opts: { dryRun?: boolean },
): Promise<{ changed: boolean; result: Record<string, unknown> }> {
  if (!fs.existsSync(filePath)) {
    return { changed: false, result: {} };
  }

  const text = fs.readFileSync(filePath, "utf8");
  let raw: Record<string, unknown>;
  try {
    const stripped = stripJsonComments(text);
    const parsed = JSON.parse(stripped);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warn(`[akm] config-migrate: ${filePath} is not a valid JSON object, skipping.`);
      return { changed: false, result: {} };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    warn(`[akm] config-migrate: failed to parse ${filePath}, skipping.`);
    return { changed: false, result: {} };
  }

  const { changed, result } = migrateConfigShape(raw);

  if (!changed) {
    return { changed: false, result };
  }

  if (opts.dryRun) {
    return { changed: true, result };
  }

  backupConfigFile(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  return { changed: true, result };
}

function discoverProjectConfigPaths(startDir: string): string[] {
  const paths: string[] = [];
  let currentDir = path.resolve(startDir);

  while (true) {
    const configPath = path.join(currentDir, PROJECT_CONFIG_RELATIVE_PATH);
    if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
      paths.unshift(configPath);
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return paths;
}

export async function runConfigMigrate(opts: { dryRun?: boolean; noWait?: boolean }): Promise<void> {
  const userConfigPath = getConfigPath();
  const projectPaths = discoverProjectConfigPaths(process.cwd());

  const allPaths = [userConfigPath, ...projectPaths].filter((p, i, arr) => arr.indexOf(p) === i && fs.existsSync(p));

  if (allPaths.length === 0) {
    console.log("No config files found to migrate.");
    return;
  }

  for (const configPath of allPaths) {
    const lockPath = path.join(path.dirname(configPath), ".akm", "migrate.lock");
    const release = acquireMigrateLock(lockPath, opts.noWait ?? false);

    if (!release) {
      console.error(`[akm] Migration of ${configPath} is already in progress (lock held). Use --no-wait to skip.`);
      continue;
    }

    try {
      const { changed, result } = await migrateConfigFile(configPath, { dryRun: opts.dryRun });

      if (!changed) {
        console.log(`${configPath}: already at 0.8.0 — no changes needed.`);
      } else if (opts.dryRun) {
        console.log(`${configPath}: would migrate to 0.8.0 (--dry-run, not written):`);
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`${configPath}: migrated to 0.8.0.`);
      }
    } finally {
      release();
    }
  }
}
