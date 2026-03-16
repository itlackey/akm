import { resolveStashDir } from "../common";
import type { AgentikitConfig, StashConfigEntry } from "../config";
import { loadConfig } from "../config";
import { searchLocal } from "../local-search";
import type { StashProvider, StashSearchOptions, StashSearchResult } from "../stash-provider";
import { registerStashProvider } from "../stash-provider-factory";
import { showLocal } from "../stash-show";
import { resolveStashSources } from "../stash-source";
import type { KnowledgeView, ShowResponse } from "../stash-types";

class FilesystemStashProvider implements StashProvider {
  readonly type = "filesystem";
  readonly name: string;
  private readonly stashDir: string;
  private readonly config: AgentikitConfig;

  constructor(entry: StashConfigEntry) {
    this.config = loadConfig();
    this.stashDir = entry.path ?? resolveStashDir();
    this.name = entry.name ?? this.stashDir;
  }

  async search(options: StashSearchOptions): Promise<StashSearchResult> {
    const sources = resolveStashSources(this.stashDir, this.config);
    const result = await searchLocal({
      query: options.query.toLowerCase(),
      searchType: options.type ?? "any",
      limit: options.limit,
      stashDir: this.stashDir,
      sources,
      config: this.config,
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
    return !ref.trim().startsWith("viking://");
  }
}

// ── Self-register ───────────────────────────────────────────────────────────

registerStashProvider("filesystem", (config) => new FilesystemStashProvider(config));
