import { registerSourceProvider } from "../provider-factory";
import { ensureWebsiteMirror, getWebsiteCachePaths, validateWebsiteUrl } from "../website-ingest";

/**
 * Website source provider — thin adapter over the shared website ingest module.
 */
registerSourceProvider("website", (config) => {
  const url = validateWebsiteUrl(config.url ?? "");
  const name = config.name ?? "website";
  return {
    kind: "website" as const,
    name,
    async init(_ctx) {},
    path() {
      return getWebsiteCachePaths(url).stashDir;
    },
    async sync() {
      await ensureWebsiteMirror(config, { requireStashDir: true });
    },
  };
});
