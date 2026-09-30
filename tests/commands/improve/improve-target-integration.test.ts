import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmConsolidate } from "../../../src/commands/improve/consolidate";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig, ImproveProfileConfig } from "../../../src/core/config/config";
import { ConfigError, UsageError } from "../../../src/core/errors";
import { resolveWriteTarget } from "../../../src/core/write-source";
import { getCachePaths, parseGitRepoUrl } from "../../../src/sources/providers/git";
import { getWebsiteCachePaths } from "../../../src/sources/snapshot-fetchers/website-ingest";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import { seedLockEntries } from "../../_helpers/lockfile";
import {
  type Cleanup,
  makeStashDir,
  mutateScopedEnv,
  type SandboxedDir,
  sandboxXdgDataHome,
} from "../../_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];
let envCleanup: Cleanup = () => {};

function stash(): string {
  const sb = makeStashDir();
  sandboxes.push(sb);
  return sb.dir;
}

function targetConfig(primary: string, team: string, readonly: string): AkmConfig {
  return withTestImproveLlm({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: {
      primary: { path: primary, writable: true },
      team: { path: team, writable: true },
      vendor: { path: readonly, writable: false },
    },
    defaultBundle: "primary",
    defaultWriteTarget: "primary",
  } as AkmConfig);
}

beforeEach(() => {
  envCleanup = sandboxXdgDataHome().cleanup;
});

afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
  envCleanup();
  envCleanup = () => {};
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

  test("a dry run without a selector previews the working bundle the live run writes to (AKM_BUNDLE_DIR first)", async () => {
    const primary = stash();
    const team = stash();
    // No `defaultWriteTarget`, so both runs start from the working bundle, which AKM_BUNDLE_DIR overrides.
    const config = withTestImproveLlm({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { primary: { path: primary, writable: true }, team: { path: team, writable: true } },
      defaultBundle: "primary",
    } as AkmConfig);
    mutateScopedEnv("AKM_BUNDLE_DIR", team);
    let selectedRoot: string | undefined;

    await akmImprove({
      dryRun: true,
      config,
      collectEligibleRefsFn: async (_scope, stashDir) => {
        selectedRoot = stashDir;
        return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
      },
    });

    expect(path.resolve(selectedRoot ?? "")).toBe(path.resolve(resolveWriteTarget(config).source.path));
    expect(path.resolve(selectedRoot ?? "")).toBe(path.resolve(team));
  });

  test("a qualified scope selects its bundle and conflicts with a different --bundle", async () => {
    const primary = stash();
    const team = stash();
    const vendor = stash();
    const config = targetConfig(primary, team, vendor);
    let selectedRoot: string | undefined;
    const collectEligibleRefsFn = async (_scope: unknown, stashDir?: string) => {
      selectedRoot = stashDir;
      return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
    };

    await akmImprove({ scope: "team//memories/shared", dryRun: true, config, collectEligibleRefsFn });
    expect(path.resolve(selectedRoot ?? "")).toBe(path.resolve(team));

    await expect(
      akmImprove({
        scope: "team//memories/shared",
        target: "primary",
        dryRun: true,
        config,
        collectEligibleRefsFn,
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  // `akm improve` spells its destination flag `--bundle` (`--target` was renamed in 0.9), so
  // every error a wrong bundle raises, in a dry run and a live one, must say so.
  describe("names --bundle, never --target, when the selected bundle is wrong", () => {
    const failure = async (run: () => Promise<unknown>): Promise<{ message: string; hint: string }> => {
      try {
        await run();
      } catch (error) {
        const { message } = error as Error;
        return { message, hint: (error as { hint?: () => string | undefined }).hint?.() ?? "" };
      }
      throw new Error("expected akmImprove to throw");
    };
    const settled = {
      collectEligibleRefsFn: async () => ({
        plannedRefs: [],
        memorySummary: { eligible: 0, derived: 0 },
        strategyFilteredRefs: [],
      }),
    };

    test("a qualified scope against a different bundle, dry run and live", async () => {
      const config = targetConfig(stash(), stash(), stash());
      const scope = "team//memories/shared";
      for (const dryRun of [true, false]) {
        const { message, hint } = await failure(() =>
          akmImprove({ scope, target: "primary", dryRun, config, ...settled }),
        );
        expect(message).toBe('Qualified ref bundle "team" conflicts with --bundle "primary".');
        expect(hint).toContain("Drop --bundle");
        expect(`${message} ${hint}`).not.toContain("--target");
      }
    });

    test("an unknown bundle", async () => {
      const config = targetConfig(stash(), stash(), stash());
      const { message } = await failure(() => akmImprove({ target: "ghost", config, ...settled }));
      expect(message).toContain('--bundle must reference a source name from your config. No source named "ghost"');
      expect(message).not.toContain("--target");
    });

    test("a read-only bundle, named by --bundle or by a qualified scope", async () => {
      const config = targetConfig(stash(), stash(), stash());
      for (const options of [{ target: "vendor" }, { scope: "vendor//knowledge/guide" }]) {
        const { hint } = await failure(() => akmImprove({ ...options, config, ...settled }));
        expect(hint).toContain("or pass --bundle to a different source");
        expect(hint).not.toContain("--target");
      }
    });
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
      processes: { consolidate: { enabled: true } },
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

  for (const kind of ["website", "npm"] as const) {
    test(`qualified dry-run can inspect a read-only ${kind} bundle while a live run rejects it`, async () => {
      const primary = stash();
      const websiteUrl = "https://example.com/improve-read-only";
      const websitePaths = getWebsiteCachePaths(websiteUrl);
      const vendor = kind === "website" ? websitePaths.rootDir : stash();
      fs.mkdirSync(vendor, { recursive: true });
      if (kind === "npm") {
        seedLockEntries([{ id: "vendor", source: "npm", ref: "npm:improve-read-only@1.0.0", localRoot: vendor }]);
      }
      const config = withTestImproveLlm({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: {
          primary: { path: primary, writable: true },
          vendor: kind === "website" ? { website: { url: websiteUrl } } : { npm: "npm:improve-read-only@1.0.0" },
        },
        defaultBundle: "primary",
        defaultWriteTarget: "primary",
      } as AkmConfig);
      let selectedRoot: string | undefined;

      try {
        const result = await akmImprove({
          scope: "vendor//knowledge/guide",
          dryRun: true,
          config,
          ensureIndexFn: async () => {},
          collectEligibleRefsFn: async (_scope, stashDir) => {
            selectedRoot = stashDir;
            return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
          },
        });

        expect(result.dryRun).toBe(true);
        expect(path.resolve(selectedRoot ?? "")).toBe(path.resolve(vendor));
        await expect(akmImprove({ scope: "vendor//knowledge/guide", config })).rejects.toBeInstanceOf(ConfigError);
      } finally {
        if (kind === "website") fs.rmSync(websitePaths.rootDir, { recursive: true, force: true });
      }
    });
  }

  test("judgedNoAction accounting does not suppress the same bare ref in another source", async () => {
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
      processes: { consolidate: { enabled: true } },
    } as ImproveProfileConfig;

    const first = await akmConsolidate({ target: "primary", config, improveProfile: profile });
    const second = await akmConsolidate({ target: "team", config, improveProfile: profile });

    expect(first.judgedNoAction).toBe(1);
    expect(second.judgedNoAction).toBe(1);
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
        bundles: {
          stash: { path: primary, writable: true },
          team: { git: url, writable: true },
        },
        defaultBundle: "stash",
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
