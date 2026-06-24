/**
 * Website-source update integration (#664).
 *
 * Relocated from `tests/source-qa-fixes.test.ts` (issue #19 website case). The
 * website crawl reaches the network deep inside `ensureWebsiteMirror ->
 * crawlWebsite -> fetchWebsitePage -> fetchWithRetry`, behind the generic
 * source-provider `sync()` boundary that takes no injectable fetch. Per the
 * #664 seam design this is a genuinely transport-shaped case kept as a thin
 * integration test against a real `Bun.serve`, not de-socketed. The remaining
 * source-qa-fixes assertions (kind/writable/name) stay in the pure unit tier.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmUpdate } from "../../src/commands/sources/installed-stashes";
import { saveConfig } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("issue #19: akm update website sources", () => {
  test("website source update does not throw TARGET_NOT_UPDATABLE", async () => {
    // Use a local HTTP server to serve minimal HTML for the crawl
    const server = Bun.serve({
      port: 0,
      fetch(_req: Request) {
        return new Response(
          "<html><head><title>Test</title></head><body><h1>Test</h1><p>hello world</p></body></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    const siteUrl = `http://127.0.0.1:${server.port}`;

    try {
      saveConfig({
        semanticSearchMode: "off",
        sources: [{ type: "website", url: siteUrl, name: "test-site" }],
      });

      // Should not throw TARGET_NOT_UPDATABLE
      const result = await akmUpdate({ target: "test-site", stashDir: storage.stashDir });
      // Returns an UpdateResponse with processed[] (empty for website sources)
      expect(result).toBeDefined();
      expect(result.schemaVersion).toBe(1);
      expect(result.processed).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
