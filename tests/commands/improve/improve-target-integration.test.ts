import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmConsolidate } from "../../../src/commands/improve/consolidate";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig, ImproveProfileConfig } from "../../../src/core/config/config";
import { getCachePaths, parseGitRepoUrl } from "../../../src/sources/providers/git";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import { makeStashDir, type SandboxedDir } from "../../_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];

function stash(): string {
  const sb = makeStashDir();
  sandboxes.push(sb);
  return sb.dir;
}

function targetConfig(primary: string, team: string, readonly: string): AkmConfig {
  return withTestImproveLlm({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    stashDir: primary,
    sources: [
      { type: "filesystem", name: "primary", path: primary, writable: true },
      { type: "filesystem", name: "team", path: team, writable: true },
      { type: "filesystem", name: "vendor", path: readonly, writable: false },
    ],
    defaultWriteTarget: "primary",
  } as AkmConfig);
}

afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

describe("improve named target integration", () => {
  test("resolves an explicit source name to its canonical root before selecting inputs", async () => {
    const primary = stash();
    const team = stash();
    const vendor = stash();
    const config = targetConfig(primary, team, vendor);
    let selectedRoot: string | undefined;

    await akmImprove({
      target: "team",
      dryRun: true,
      config,
      collectEligibleRefsFn: async (_scope, stashDir) => {
        selectedRoot = stashDir;
        return {
          plannedRefs: [],
          memorySummary: { eligible: 0, derived: 0 },
          strategyFilteredRefs: [],
        };
      },
    });

    expect(path.resolve(selectedRoot ?? "")).toBe(path.resolve(team));
  });

  test("consolidation isolates the selected source when another source has the same bare ref", async () => {
    const primary = stash();
    const team = stash();
    const vendor = stash();
    const config = targetConfig(primary, team, vendor);
    const duplicateName = "shared/duplicate";
    for (const [root, marker] of [
      [team, "team"],
      [vendor, "vendor"],
    ] as const) {
      const file = path.join(root, "memories", `${duplicateName}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `---\ndescription: ${marker} duplicate\ncaptureMode: hot\n---\n\n${marker} source body.\n`,
        "utf8",
      );
    }

    const profile = {
      processes: { consolidate: { enabled: true }, extract: { hotProbation: { enabled: false } } },
    } as ImproveProfileConfig;
    const result = await akmConsolidate({
      target: "team",
      stashDir: primary,
      config,
      improveProfile: profile,
    });

    expect(result.processed).toBe(1);
    expect(result.judgedNoAction).toBe(1);
    expect(result.target).toBe("team");
  });

  test("dry-run can inspect an explicitly selected read-only source", async () => {
    const primary = stash();
    const team = stash();
    const vendor = stash();
    const config = targetConfig(primary, team, vendor);
    let selectedRoot: string | undefined;

    const result = await akmImprove({
      target: "vendor",
      dryRun: true,
      config,
      collectEligibleRefsFn: async (_scope, stashDir) => {
        selectedRoot = stashDir;
        return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
      },
    });

    expect(result.dryRun).toBe(true);
    expect(path.resolve(selectedRoot ?? "")).toBe(path.resolve(vendor));
  });

  test("judged cache does not suppress the same bare ref in another source", async () => {
    const primary = stash();
    const team = stash();
    const vendor = stash();
    const duplicateName = "shared/duplicate";
    for (const root of [primary, team]) {
      const file = path.join(root, "memories", `${duplicateName}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "---\ndescription: duplicate\ncaptureMode: hot\n---\n\nSame body.\n", "utf8");
    }
    const config = targetConfig(primary, team, vendor);
    const profile = {
      processes: { consolidate: { enabled: true }, extract: { hotProbation: { enabled: false } } },
    } as ImproveProfileConfig;

    const first = await akmConsolidate({ target: "primary", config, improveProfile: profile });
    const second = await akmConsolidate({ target: "team", config, improveProfile: profile });

    expect(first.judgedNoAction).toBe(1);
    expect(second.judgedNoAction).toBe(1);
    expect(second.perfTelemetry?.judgedCacheSkipped ?? 0).toBe(0);
  });

  test("improve reads the git content root in both supported repository layouts", async () => {
    for (const layout of ["content", "root"] as const) {
      const primary = stash();
      const url = `https://example.invalid/acme/improve-${layout}.git`;
      const paths = getCachePaths(parseGitRepoUrl(url).canonicalUrl);
      const expectedRoot = layout === "content" ? path.join(paths.repoDir, "content") : paths.repoDir;
      fs.mkdirSync(expectedRoot, { recursive: true });
      const config = withTestImproveLlm({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        stashDir: primary,
        sources: [{ type: "git", name: "team", url, writable: true }],
        defaultWriteTarget: "team",
      } as AkmConfig);
      let selectedRoot: string | undefined;

      await akmImprove({
        target: "team",
        dryRun: true,
        config,
        collectEligibleRefsFn: async (_scope, stashDir) => {
          selectedRoot = stashDir;
          return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
        },
      });

      expect(path.resolve(selectedRoot ?? "")).toBe(path.resolve(expectedRoot));
      fs.rmSync(paths.rootDir, { recursive: true, force: true });
    }
  });
});
