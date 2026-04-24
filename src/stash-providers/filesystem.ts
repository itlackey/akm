import { resolveStashDir } from "../common";
import type { StashConfigEntry } from "../config";
import { loadConfig } from "../config";
import { searchLocal } from "../local-search";
import { resolveStashSources } from "../search-source";
import type { LiveStashProvider, StashSearchOptions, StashSearchResult } from "../stash-provider";
import { registerStashProvider } from "../stash-provider-factory";
import { showLocal } from "../stash-show";
import type { KnowledgeView, ShowResponse } from "../stash-types";

class FilesystemStashProvider implements LiveStashProvider {
  readonly type = "filesystem";
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
}

// ── Self-register ───────────────────────────────────────────────────────────

registerStashProvider("filesystem", (config) => new FilesystemStashProvider(config));
