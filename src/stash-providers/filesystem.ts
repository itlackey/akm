import { resolveStashDir } from "../common";
import type { StashConfigEntry } from "../config";
import { loadConfig } from "../config";
import { searchLocal } from "../db-search";
import { ConfigError } from "../errors";
import { resolveStashSources } from "../search-source";
import type {
  StashLockData,
  StashSearchOptions,
  StashSearchResult,
  SyncableStashProvider,
  SyncOptions,
} from "../stash-provider";
import { registerStashProvider } from "../stash-provider-factory";
import { showLocal } from "../stash-show";
import type { KnowledgeView, ShowResponse } from "../stash-types";
import { detectStashRoot } from "./provider-utils";

class FilesystemStashProvider implements SyncableStashProvider {
  readonly type = "filesystem";
  readonly kind = "syncable" as const;
  readonly name: string;
  private readonly stashDir: string;

  constructor(entry: StashConfigEntry) {
    this.stashDir = entry.path ?? resolveStashDir();
    this.name = entry.name ?? this.stashDir;
  }

  async search(options: StashSearchOptions): Promise<StashSearchResult> {
    const config = loadConfig();
    const sources = resolveStashSources(this.stashDir, config);
    const result = await searchLocal({
      query: options.query.toLowerCase(),
      searchType: options.type ?? "any",
      limit: options.limit,
      stashDir: this.stashDir,
      sources,
      config,
    });
    return {
      hits: result.hits,
      warnings: result.warnings,
      embedMs: result.embedMs,
      rankMs: result.rankMs,
    };
  }

  async show(ref: string, view?: KnowledgeView): Promise<ShowResponse> {
    return showLocal({ ref, view });
  }

  canShow(ref: string): boolean {
    return !ref.includes("://");
  }

  /** No-op: a filesystem stash already lives on disk. */
  async sync(config: StashConfigEntry, options?: SyncOptions): Promise<StashLockData> {
    if (!config.path) {
      throw new ConfigError("filesystem stash entry must include a `path`");
    }
    const stashRoot = detectStashRoot(config.path);
    const syncedAt = (options?.now ?? new Date()).toISOString();
    return {
      id: stashRoot,
      source: "local",
      ref: stashRoot,
      artifactUrl: stashRoot,
      contentDir: stashRoot,
      cacheDir: stashRoot,
      extractedDir: stashRoot,
      syncedAt,
    };
  }

  getContentDir(config: StashConfigEntry): string {
    if (!config.path) {
      throw new ConfigError("filesystem stash entry must include a `path`");
    }
    return config.path;
  }

  async remove(_config: StashConfigEntry): Promise<void> {
    // Filesystem stashes are user-managed; never delete the source on `akm remove`.
  }
}

// ── Self-register ───────────────────────────────────────────────────────────

registerStashProvider("filesystem", (config) => new FilesystemStashProvider(config));
