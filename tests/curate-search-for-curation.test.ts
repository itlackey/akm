import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { searchForCuration } from "../src/commands/read/curate";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { withIsolatedAkmStorage } from "./_helpers/sandbox";

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function withIndexedStash<T>(fn: (stashDir: string) => Promise<T>): Promise<T> {
  const storage = withIsolatedAkmStorage();
  try {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir } },
      defaultBundle: "stash",
      registries: [],
    });
    return await fn(storage.stashDir);
  } finally {
    storage.cleanup();
  }
}

describe("searchForCuration", () => {
  test("falls back when the initial phrase hit is weak", async () => {
    await withIndexedStash(async (stashDir) => {
      writeFile(
        path.join(stashDir, "commands", "cleanup-audit.md"),
        "---\ndescription: Review cleanup audit notes and release coordination\n---\nReview docker cleanup audit notes for the release retrospective.\n",
      );
      writeFile(
        path.join(stashDir, "scripts", "docker-clean.sh"),
        "#!/usr/bin/env bash\n# Clean up unused Docker images and containers\ndocker system prune -af\n",
      );

      await akmIndex({ stashDir, full: true });

      const result = await searchForCuration({
        query: "docker cleanup audit",
        limit: 12,
        source: "local",
      });

      const refs = result.hits.map((hit) => ("ref" in hit ? hit.ref : `registry:${hit.id}`));
      expect(refs).toContain("scripts/docker-clean.sh");
      expect(refs).toContain("commands/cleanup-audit");
      // Search fix round 2 / item 2: the lexical tier ladder no longer
      // early-exits at the first non-empty tier, so docker-clean.sh is now
      // found directly by the base 3-token query too (previously it was
      // fallback-only and reached the front only via the weak-lexical-base
      // promotion path in `mergeCurateSearchResponses`). That function's own
      // merge is deliberately base-order-preserving for a hit already in the
      // base result (see its doc comment) — array position there is not a
      // score order, only `curateSearchResults`'s downstream selector
      // re-sorts by score — so assert relevance via score, which is what
      // actually reaches `akm curate`'s output order.
      const byRef = new Map(result.hits.map((hit) => ["ref" in hit ? hit.ref : `registry:${hit.id}`, hit]));
      const dockerScore = byRef.get("scripts/docker-clean.sh")?.score ?? 0;
      const auditScore = byRef.get("commands/cleanup-audit")?.score ?? 0;
      expect(dockerScore).toBeGreaterThan(auditScore);
    });
  });

  test("does not need fallback when the initial phrase search is already strong", async () => {
    await withIndexedStash(async (stashDir) => {
      writeFile(
        path.join(stashDir, "skills", "docker-homelab", "SKILL.md"),
        "---\ndescription: Manage Docker containers in a homelab\n---\n# Docker Homelab\nUse Docker Compose, containers, and networking in a homelab.\n",
      );
      writeFile(
        path.join(stashDir, "knowledge", "docker-compose-reference.md"),
        "# Docker Compose Reference\n\nReference for Docker Compose services and files.\n",
      );

      await akmIndex({ stashDir, full: true });

      const result = await searchForCuration({
        query: "docker homelab",
        limit: 12,
        source: "local",
      });

      const refs = result.hits.map((hit) => ("ref" in hit ? hit.ref : `registry:${hit.id}`));
      expect(refs[0]).toBe("skills/docker-homelab");
      expect(refs).toContain("knowledge/docker-compose-reference");
    });
  });

  test("allows one-token prompt-residue fallback", async () => {
    await withIndexedStash(async (stashDir) => {
      writeFile(
        path.join(stashDir, "scripts", "docker-clean.sh"),
        "#!/usr/bin/env bash\n# Clean up unused Docker images and containers\ndocker system prune -af\n",
      );
      writeFile(
        path.join(stashDir, "skills", "docker-homelab", "SKILL.md"),
        "---\ndescription: Manage Docker containers in a homelab\n---\n# Docker Homelab\nUse Docker containers and Compose in a homelab.\n",
      );

      await akmIndex({ stashDir, full: true });

      const result = await searchForCuration({ query: "the docker", limit: 12, source: "local" });

      const refs = result.hits.map((hit) => ("ref" in hit ? hit.ref : `registry:${hit.id}`));
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.some((ref) => ref.includes("docker"))).toBe(true);
    });
  });
});
