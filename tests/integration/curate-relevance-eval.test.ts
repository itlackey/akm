import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmCurate } from "../../src/commands/read/curate";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

const BASELINE = {
  dockerHomelab: ["knowledge/skills/docker-homelab/references/compose", "skills/docker-homelab"],
  dockerDeploy: [
    "scripts/docker-clean",
    "knowledge/skills/docker-homelab/references/compose",
    "skills/docker-homelab",
    "commands/release-manager",
  ],
  theDocker: [] as string[],
  howDocker: [] as string[],
} as const;

const RANKING_BASELINE_FIXTURE = path.join(__dirname, "..", "fixtures", "stashes", "ranking-baseline");

async function curateRefs(query: string): Promise<string[]> {
  const result = await akmCurate({ query, limit: 4 });
  return result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`));
}

function familyOccupancy(refs: string[], familyKey: string): number {
  return refs.filter(
    (ref) => ref === `skills/${familyKey}` || ref.startsWith(`knowledge/skills/${familyKey}/references/`),
  ).length;
}

function bannedCount(refs: string[], banned: string): number {
  return refs.filter((ref) => ref === banned).length;
}

describe("curate relevance improvements", () => {
  test("improves measurable quality over the pre-change curate baseline", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      fs.cpSync(RANKING_BASELINE_FIXTURE, storage.stashDir, { recursive: true });
      saveConfig({
        semanticSearchMode: "off",
        bundles: { stash: { path: storage.stashDir } },
        defaultBundle: "stash",
        registries: [],
      });
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const dockerHomelab = await curateRefs("docker homelab");
      const dockerDeploy = await curateRefs("docker deploy");
      const theDocker = await curateRefs("the docker");
      const howDocker = await curateRefs("how docker");

      expect(familyOccupancy(dockerHomelab, "docker-homelab")).toBeLessThan(
        familyOccupancy([...BASELINE.dockerHomelab], "docker-homelab"),
      );
      expect(bannedCount(dockerDeploy, "commands/release-manager")).toBeLessThan(
        bannedCount([...BASELINE.dockerDeploy], "commands/release-manager"),
      );
      expect(theDocker.length).toBeGreaterThan(BASELINE.theDocker.length);
      expect(theDocker.some((ref) => ref.includes("docker"))).toBe(true);
      expect(howDocker.length).toBeGreaterThan(BASELINE.howDocker.length);
      expect(howDocker.some((ref) => ref.includes("docker"))).toBe(true);
      expect(dockerHomelab.length).toBeLessThan(BASELINE.dockerHomelab.length);
    } finally {
      storage.cleanup();
    }
  });
});
