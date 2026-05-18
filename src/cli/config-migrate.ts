import fs from "node:fs";
import path from "node:path";
import { stripJsonComments } from "../core/config";
import { migrateConfigShape } from "../core/config-migration";
import { getCacheDir, getConfigPath } from "../core/paths";
import { warn } from "../core/warn";

export { migrateConfigShape } from "../core/config-migration";

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

  const lockPath = path.join(getCacheDir(), "config-migrate.lock");
  const releaseLock = acquireMigrateLock(lockPath, opts.noWait ?? false);
  if (!releaseLock) {
    warn("[akm] config-migrate: another migration is already in progress, skipping.");
    return;
  }

  try {
    let anyChanged = false;
    for (const filePath of allPaths) {
      const { changed } = await migrateConfigFile(filePath, { dryRun: opts.dryRun });
      if (changed) {
        const action = opts.dryRun ? "would migrate" : "migrated";
        console.log(`[akm] ${action}: ${filePath}`);
        anyChanged = true;
      } else {
        console.log(`[akm] already up to date: ${filePath}`);
      }
    }
    if (!anyChanged) {
      console.log("All config files are already at the current version.");
    }
  } finally {
    releaseLock();
  }
}
