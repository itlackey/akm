import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { searchForCuration } from "../../src/commands/read/curate";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function withIndexedStash<T>(fn: (stashDir: string) => Promise<T>): Promise<T> {
  const storage = withIsolatedAkmStorage();
  try {
    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: storage.stashDir }],
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
        source: "stash",
      });

      const refs = result.hits.map((hit) => ("ref" in hit ? hit.ref : `registry:${hit.id}`));
      expect(refs).toContain("scripts/docker-clean.sh");
      expect(refs).toContain("commands/cleanup-audit");
      expect(refs.indexOf("scripts/docker-clean.sh")).toBeLessThan(refs.indexOf("commands/cleanup-audit"));
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
        source: "stash",
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

      const result = await searchForCuration({ query: "the docker", limit: 12, source: "stash" });

      const refs = result.hits.map((hit) => ("ref" in hit ? hit.ref : `registry:${hit.id}`));
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.some((ref) => ref.includes("docker"))).toBe(true);
    });
  });
});
