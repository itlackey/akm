// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1000: an improve run reads and writes ONE bundle, its write target.
 *
 * Candidate selection used to admit assets from every writable bundle while the
 * run filed every proposal into its write target, so reflect read an asset from
 * bundle B and the proposal landed in bundle A: a `create` fork of B's asset,
 * or an `update` of A's own copy built from B's copy. These tests run against a
 * real index of two writable bundles.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { collectEligibleRefs, collectEligibleRefsReadOnly } from "../../../../src/commands/improve/eligibility";
import { akmImprove } from "../../../../src/commands/improve/improve";
import { akmReflect } from "../../../../src/commands/improve/reflect";
import { listProposals } from "../../../../src/commands/proposal/repository";
import { type AkmConfig, saveConfig } from "../../../../src/core/config/config";
import { NotFoundError } from "../../../../src/core/errors";
import { appendEvent } from "../../../../src/core/events";
import { akmIndex } from "../../../../src/indexer/indexer";
import { withTestImproveLlm } from "../../../_helpers/improve-config";
import { type IsolatedAkmStorage, mutateScopedEnv, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let primary: string;
let team: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  primary = path.join(storage.root, "primary-bundle");
  team = path.join(storage.root, "team-bundle");
  mutateScopedEnv("AKM_BUNDLE_DIR", primary);
});

afterEach(() => {
  storage.cleanup();
});

function writeSkill(root: string, name: string, body: string): void {
  const file = path.join(root, "skills", name, "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`, "utf8");
}

function writeMemory(root: string, name: string): void {
  const file = path.join(root, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${name}\n---\n\n${name} body.\n`, "utf8");
}

/** Two writable bundles; `primary` is where the run writes. No judge is configured, so proposals queue unjudged. */
function twoBundleConfig(defaultBundle = "primary"): AkmConfig {
  return withTestImproveLlm({
    semanticSearchMode: "off",
    bundles: {
      primary: { path: primary, writable: true },
      team: { path: team, writable: true },
    },
    defaultBundle,
    defaultWriteTarget: "primary",
    improve: { strategies: { default: { processes: { distill: { qualityGate: { enabled: false } } } } } },
  } as AkmConfig);
}

/**
 * Seed both bundles and index them with `team` walked first, so its rows carry
 * the lower ids: a bare conceptId present in both bundles then resolves to
 * team's copy, the ordering that filed team's content under primary.
 */
async function seedAndIndex(config: AkmConfig): Promise<void> {
  writeSkill(primary, "local-skill", "PRIMARY local skill.");
  writeSkill(primary, "shared-skill", "PRIMARY copy of the shared skill.");
  writeMemory(primary, "primary-note");
  writeSkill(team, "team-skill", "TEAM-only skill.");
  writeSkill(team, "shared-skill", "TEAM copy of the shared skill.");
  writeMemory(team, "team-note");
  saveConfig(config);
  await akmIndex({ stashDir: team, full: true });
}

describe("candidate selection is bound to the run's write target", () => {
  test("plans only the write target's assets when another writable bundle owns more", async () => {
    const config = twoBundleConfig();
    await seedAndIndex(config);

    const result = await collectEligibleRefs({ mode: "all" }, primary, {}, config);

    expect(result.plannedRefs.map((entry) => entry.itemRef).sort()).toEqual([
      "primary//memories/primary-note",
      "primary//skills/local-skill",
      "primary//skills/shared-skill",
    ]);
    // Counts describe the write target's pool, not the union of writable bundles.
    expect(result.memorySummary).toEqual({ eligible: 1, derived: 0 });
  });

  test("plans the write target's copy of an asset present in both bundles", async () => {
    const config = twoBundleConfig();
    await seedAndIndex(config);

    const result = await collectEligibleRefs({ mode: "type", value: "skill" }, primary, {}, config);
    const shared = result.plannedRefs.find((entry) => entry.ref === "skills/shared-skill");

    expect(shared?.itemRef).toBe("primary//skills/shared-skill");
    expect(shared?.filePath).toBe(path.join(primary, "skills", "shared-skill", "SKILL.md"));
  });

  test("selecting the other bundle as the write target plans that bundle's assets instead", async () => {
    const config = twoBundleConfig();
    await seedAndIndex(config);

    const result = await collectEligibleRefs({ mode: "type", value: "skill" }, team, {}, config);

    expect(result.plannedRefs.map((entry) => entry.itemRef).sort()).toEqual([
      "team//skills/shared-skill",
      "team//skills/team-skill",
    ]);
  });

  test("without an explicit root the working bundle is the write target", async () => {
    const config = twoBundleConfig();
    await seedAndIndex(config);

    const result = await collectEligibleRefs({ mode: "type", value: "skill" }, undefined, {}, config);

    expect(result.plannedRefs.map((entry) => entry.itemRef).sort()).toEqual([
      "primary//skills/local-skill",
      "primary//skills/shared-skill",
    ]);
  });

  test("a read-only write target plans nothing, whatever other writable bundles hold", async () => {
    const vendor = path.join(storage.root, "vendor-bundle");
    writeSkill(vendor, "vendor-skill", "VENDOR skill.");
    const base = twoBundleConfig();
    const config = { ...base, bundles: { ...base.bundles, vendor: { path: vendor, writable: false } } } as AkmConfig;
    await seedAndIndex(config);

    const result = await collectEligibleRefsReadOnly({ mode: "all" }, vendor, {}, config);

    expect(result.plannedRefs).toEqual([]);
  });

  test("an unqualified scope ref resolves inside the write target, not through the default bundle", async () => {
    const config = twoBundleConfig("team");
    await seedAndIndex(config);

    const result = await collectEligibleRefs({ mode: "ref", value: "skills/shared-skill" }, primary, {}, config);

    expect(result.plannedRefs).toEqual([
      expect.objectContaining({ itemRef: "primary//skills/shared-skill", reason: "scope-ref" }),
    ]);
  });

  test("a scope ref owned only by another bundle is not planned into the write target", async () => {
    const config = twoBundleConfig();
    await seedAndIndex(config);

    const unqualified = await collectEligibleRefs(
      { mode: "ref", value: "skills/team-skill" },
      primary,
      {},
      config,
    ).catch((error: unknown) => error);
    expect(unqualified).toBeInstanceOf(NotFoundError);
    // The default "refresh the index" advice would be wrong here: the asset is indexed, in another bundle.
    expect((unqualified as NotFoundError).hint()).toContain("--bundle <bundle>");
    await expect(
      collectEligibleRefs({ mode: "ref", value: "team//skills/team-skill" }, primary, {}, config),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("an improve run never files another bundle's asset into its write target", () => {
  const LLM_BODY = "Rewritten by the model.";

  /** Signals for every skill in both bundles, so the loop would pick all of them. */
  function signalEverySkill(): void {
    for (const itemRef of [
      "primary//skills/local-skill",
      "primary//skills/shared-skill",
      "team//skills/team-skill",
      "team//skills/shared-skill",
    ]) {
      appendEvent({ eventType: "feedback", ref: itemRef, metadata: { signal: "positive", note: "fixture" } });
    }
  }

  /** Real reflect over a fake model; records what the loop handed it and what the model saw. */
  function recordingReflect(calls: Array<{ itemRef: string | undefined; prompt: string }>) {
    return (options: Parameters<typeof akmReflect>[0]) => {
      const call = { itemRef: options?.itemRef, prompt: "" };
      calls.push(call);
      return akmReflect({
        ...options,
        chat: async (_connection, messages) => {
          call.prompt = messages.map((message) => message.content).join("\n");
          return JSON.stringify({
            content: `---\nname: rewritten\ndescription: rewritten skill\n---\n\n${LLM_BODY}\n`,
            confidence: 0.9,
            frontmatterPatch: { description: null, when_to_use: null },
          });
        },
      });
    };
  }

  const stubs = {
    ensureIndexFn: async () => false,
    reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
    distillFn: async ({ ref }: { ref: string }) => ({
      schemaVersion: 1 as const,
      ok: true as const,
      outcome: "skipped" as const,
      inputRef: ref,
      proposalRef: ref,
    }),
  };

  test("no proposal is minted in the write target for a bundle it does not own", async () => {
    const config = twoBundleConfig();
    await seedAndIndex(config);
    signalEverySkill();
    const calls: Array<{ itemRef: string | undefined; prompt: string }> = [];

    await akmImprove({ config, scope: "skill", reflectFn: recordingReflect(calls), ...stubs });

    expect(calls.map((call) => call.itemRef).sort()).toEqual([
      "primary//skills/local-skill",
      "primary//skills/shared-skill",
    ]);
    // The model was shown primary's copies only, never team's.
    for (const call of calls) {
      expect(call.prompt).toContain("PRIMARY");
      expect(call.prompt).not.toContain("TEAM");
    }
    expect(
      listProposals(primary)
        .map((proposal) => proposal.ref)
        .sort(),
    ).toEqual(["primary//skills/local-skill", "primary//skills/shared-skill"]);
    expect(listProposals(primary).every((proposal) => proposal.changes[0]?.op === "update")).toBe(true);
  });

  test("the other bundle is improved by selecting it as the write target", async () => {
    const config = twoBundleConfig();
    await seedAndIndex(config);
    signalEverySkill();
    const calls: Array<{ itemRef: string | undefined; prompt: string }> = [];

    await akmImprove({ config, target: "team", scope: "skill", reflectFn: recordingReflect(calls), ...stubs });

    expect(calls.map((call) => call.itemRef).sort()).toEqual(["team//skills/shared-skill", "team//skills/team-skill"]);
    expect(
      listProposals(team)
        .map((proposal) => `${proposal.proposedTarget?.source}:${proposal.ref}`)
        .sort(),
    ).toEqual(["team:team//skills/shared-skill", "team:team//skills/team-skill"]);
    expect(listProposals(primary)).toEqual([]);
  });
});
