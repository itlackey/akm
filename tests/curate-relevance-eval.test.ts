import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { akmCurate } from "../src/commands/read/curate";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome, sandboxXdgDataHome } from "./_helpers/sandbox";
import { loadFixtureStash } from "./fixtures/stashes/load";

let fixtureStash = "";
let fileDataHome = "";
let envCleanup: Cleanup = () => {};
let fixtureCleanup: (() => void) | undefined;

const BASELINE = {
  dockerHomelab: ["knowledge:skills/docker-homelab/references/compose", "skill:docker-homelab"],
  dockerDeploy: [
    "script:docker-clean",
    "knowledge:skills/docker-homelab/references/compose",
    "skill:docker-homelab",
    "command:release-manager",
  ],
  theDocker: [] as string[],
  howDocker: [] as string[],
} as const;

beforeAll(async () => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  fileDataHome = dataResult.dir;
  envCleanup = dataResult.cleanup;

  const loaded = loadFixtureStash("ranking-baseline", { skipIndex: true });
  fixtureStash = loaded.stashDir;
  fixtureCleanup = loaded.cleanup;

  process.env.XDG_DATA_HOME = fileDataHome;
  process.env.AKM_STASH_DIR = fixtureStash;
  saveConfig({
    semanticSearchMode: "off",
    sources: [{ type: "filesystem", path: fixtureStash }],
    registries: [],
  });
  await akmIndex({ stashDir: fixtureStash, full: true });
});

beforeEach(() => {
  process.env.XDG_DATA_HOME = fileDataHome;
  process.env.AKM_STASH_DIR = fixtureStash;
});

afterAll(() => {
  envCleanup();
  envCleanup = () => {};
  if (process.env.AKM_STASH_DIR === fixtureStash) delete process.env.AKM_STASH_DIR;
  fixtureCleanup?.();
});

async function curateRefs(query: string): Promise<string[]> {
  const result = await akmCurate({ query, limit: 4 });
  return result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`));
}

function familyOccupancy(refs: string[], familyKey: string): number {
  return refs.filter((ref) => ref === `skill:${familyKey}` || ref.startsWith(`knowledge:skills/${familyKey}/references/`)).length;
}

function bannedCount(refs: string[], banned: string): number {
  return refs.filter((ref) => ref === banned).length;
}

describe("curate relevance improvements", () => {
  test("improves measurable quality over the pre-change curate baseline", async () => {
    const dockerHomelab = await curateRefs("docker homelab");
    const dockerDeploy = await curateRefs("docker deploy");
    const theDocker = await curateRefs("the docker");
    const howDocker = await curateRefs("how docker");

    expect(familyOccupancy(dockerHomelab, "docker-homelab")).toBeLessThan(
      familyOccupancy([...BASELINE.dockerHomelab], "docker-homelab"),
    );
    expect(bannedCount(dockerDeploy, "command:release-manager")).toBeLessThan(
      bannedCount([...BASELINE.dockerDeploy], "command:release-manager"),
    );
    expect(theDocker.length).toBeGreaterThan((BASELINE.theDocker as string[]).length);
    expect(theDocker.some((ref) => ref.includes("docker"))).toBe(true);
    expect(howDocker.length).toBeGreaterThan((BASELINE.howDocker as string[]).length);
    expect(howDocker.some((ref) => ref.includes("docker"))).toBe(true);
    expect(dockerHomelab.length).toBeLessThan(BASELINE.dockerHomelab.length);
  });
});
