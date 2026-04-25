import { resolveStashDir } from "../common";
import type { SourceConfigEntry } from "../config";
import { loadConfig } from "../config";
import { searchLocal } from "../db-search";
import { ConfigError } from "../errors";
import { resolveSourceEntries } from "../search-source";
import type {
  SourceLockData,
  SourceSearchOptions,
  SourceSearchResult,
  SyncableSourceProvider,
  SyncOptions,
} from "../source-provider";
import { registerSourceProvider } from "../source-provider-factory";
import { showLocal } from "../source-show";
import type { KnowledgeView, ShowResponse } from "../source-types";
import { detectStashRoot } from "./provider-utils";

class FilesystemSourceProvider implements SyncableSourceProvider {
  readonly type = "filesystem";
  readonly kind = "syncable" as const;
  readonly name: string;
  private readonly stashDir: string;

  constructor(entry: SourceConfigEntry) {
    this.stashDir = entry.path ?? resolveStashDir();
    this.name = entry.name ?? this.stashDir;
  }

  async search(options: SourceSearchOptions): Promise<SourceSearchResult> {
    const config = loadConfig();
    const sources = resolveSourceEntries(this.stashDir, config);
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
  async sync(config: SourceConfigEntry, options?: SyncOptions): Promise<SourceLockData> {
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

  getContentDir(config: SourceConfigEntry): string {
    if (!config.path) {
      throw new ConfigError("filesystem stash entry must include a `path`");
    }
    return config.path;
  }

  async remove(_config: SourceConfigEntry): Promise<void> {
    // Filesystem stashes are user-managed; never delete the source on `akm remove`.
  }
}

// ── Self-register ───────────────────────────────────────────────────────────

registerSourceProvider("filesystem", (config) => new FilesystemSourceProvider(config));
