import type { SourceConfigEntry } from "../../core/config";
import type { ProviderContext, SourceProvider } from "../provider";
import { registerSourceProvider } from "../provider-factory";
import { ensureWebsiteMirror, getWebsiteCachePaths, validateWebsiteUrl } from "../website-ingest";

/**
 * Website source provider — thin adapter over the shared website ingest module.
 */
class WebsiteSourceProvider implements SourceProvider {
  readonly kind = "website" as const;
  readonly name: string;
  readonly #config: SourceConfigEntry;
  readonly #url: string;

  constructor(config: SourceConfigEntry) {
    this.#config = config;
    this.name = config.name ?? "website";
    this.#url = validateWebsiteUrl(config.url ?? "");
  }

  async init(_ctx: ProviderContext): Promise<void> {
    // URL validation already happens in the constructor; nothing else to do.
  }

  path(): string {
    return getWebsiteCachePaths(this.#url).stashDir;
  }

  async sync(): Promise<void> {
    await ensureWebsiteMirror(this.#config, { requireStashDir: true });
  }
}

registerSourceProvider("website", (config) => new WebsiteSourceProvider(config));

export { WebsiteSourceProvider };
