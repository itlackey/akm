/**
 * #1454: the improve processes keep the frontmatter keys they do not own.
 *
 * An asset's ranking and scope ride on keys such as `team`, `project` and `scope_*`. Each test runs one process over
 * an asset carrying them, with a stubbed model, accepts what it queued and reads the written asset: those keys must be there.
 * Consolidate's pair pass only mints delete proposals (no content), so promotion is the consolidate path under test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { emitPromotionProposal } from "../../src/commands/improve/consolidate";
import { akmDistill } from "../../src/commands/improve/distill";
import { akmReflect } from "../../src/commands/improve/reflect";
import { akmProposalAccept } from "../../src/commands/proposal/proposal";
import { listProposals } from "../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../src/core/config/config";
import type { readEvents } from "../../src/core/events";
import { resolveWriteTarget } from "../../src/core/write-source";
import { writeFakeHarness } from "../_helpers/engine-stubs";
import { quietQualityGateConfig, reflectReply } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

/** Keys no improve process owns. */
const FOREIGN = "team: platform\nproject: atlas\nscope_user: alice\nowners:\n  - ana\n  - bo\n";
const FOREIGN_DATA = { team: "platform", project: "atlas", scope_user: "alice", owners: ["ana", "bo"] };

function expectForeign(content: string): void {
  expect(parseFrontmatter(content).data).toMatchObject(FOREIGN_DATA);
}

/** Accept the one queued proposal and return the asset it wrote. */
async function acceptedContent(stash: string): Promise<string> {
  const config = {
    semanticSearchMode: "off",
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
  } as AkmConfig;
  const { assetPath } = await akmProposalAccept({ stashDir: stash, config, id: listProposals(stash)[0]!.id });
  return fs.readFileSync(assetPath, "utf8");
}

function distillConfig(stash: string, qualityGate: boolean): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    connections: {
      default: { endpoint: "http://localhost:11434/v1/chat/completions", models: { fast: "test-model" } },
    },
    improve: {
      strategy: "test",
      strategies: { test: { processes: { distill: { enabled: true, qualityGate: { enabled: qualityGate } } } } },
    },
  } as AkmConfig;
}

const emptyEvents = (() => ({ events: [], nextOffset: 0 })) as unknown as typeof readEvents;
const positiveEvents = ((): ReturnType<typeof readEvents> => ({
  events: ["a", "b"].map((_, i) => ({
    schemaVersion: 1,
    id: i,
    ts: `2026-04-27T00:00:0${i}Z`,
    eventType: "feedback",
    ref: "memories/auth-guide",
    metadata: { signal: "positive" },
  })),
  nextOffset: 0,
})) as unknown as typeof readEvents;

describe("improve keeps the frontmatter it does not own (#1454)", () => {
  test("reflect", async () => {
    const stash = storage.stashDir;
    fs.writeFileSync(
      path.join(stash, "lessons", "rg-over-grep.md"),
      `---\ndescription: Search guidance\nwhen_to_use: Searching repositories\n${FOREIGN}---\n\nUse grep.\n`,
    );
    const bin = writeFakeHarness(stash, "fake-agent", [
      reflectReply({ description: "Use ripgrep before grep", when_to_use: "Searching large repos for patterns" }),
    ]);
    const result = await akmReflect({
      ref: "lessons/rg-over-grep",
      stashDir: stash,
      config: quietQualityGateConfig(bin),
    });
    expect(result.ok).toBe(true);
    const content = await acceptedContent(stash);
    expect(parseFrontmatter(content).data.description).toBe("Use ripgrep before grep");
    expectForeign(content);
  });

  test("consolidate promotion", async () => {
    const stash = storage.stashDir;
    const body =
      "Reusable accepted knowledge body with enough substance to pass the promotion size gate. " +
      "The second sentence keeps this fixture above the production minimum without changing its meaning.";
    const memoryPath = path.join(stash, "memories", "source.md");
    fs.writeFileSync(memoryPath, `---\ndescription: Source memory\n${FOREIGN}---\n\n${body}\n`);
    const config = {
      semanticSearchMode: "off",
      bundles: { stash: { path: stash, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
    } as AkmConfig;
    await emitPromotionProposal(
      { op: "promote", ref: "memories/source", knowledgeRef: "knowledge/new-slug", reason: "r", description: "d" },
      {
        config,
        stashDir: stash,
        sourceRun: "t",
        target: resolveWriteTarget(config),
        memoryByRef: new Map([
          [
            "memories/source",
            {
              name: "source",
              ref: "memories/source",
              filePath: memoryPath,
              description: "d",
              tags: [],
              stashDir: stash,
            },
          ],
        ]),
        promoted: [],
        promotedSourceRefs: new Set(),
        existingKnowledgeBodyHashes: new Set(),
        promotionFailures: { count: 0 },
        warnings: [],
        pushSkipReason: () => {},
      },
    );
    expectForeign(await acceptedContent(stash));
  });

  test("distill lesson update", async () => {
    const stash = storage.stashDir;
    const existingBody = "Retry a failed deploy at most three times.\n\n- Wait twice as long after each failed try.";
    const lessonPath = path.join(stash, "lessons", "deploy-retries.md");
    const existing = `---\ndescription: Bound the retries of a deploy\nwhen_to_use: A deploy fails and a retry is next\n${FOREIGN}---\n\n${existingBody}\n`;
    fs.writeFileSync(lessonPath, existing);
    const memory = path.join(stash, "memories", "deploy-retries.md");
    fs.writeFileSync(
      memory,
      "---\ndescription: deploy retries\nscope_user: alice\n---\n\nRetry a deploy at most three times. Never retry a 4xx: the request is wrong.\n",
    );
    let judged = 0;
    const newFact = "- Stop retrying at once when the error is a 4xx.";
    const result = await akmDistill({
      ref: "memories/deploy-retries",
      config: distillConfig(stash, true),
      stashDir: stash,
      fetchRelatedFn: async () => [
        { ref: "lessons/deploy-retries", type: "lesson", content: existing, path: lessonPath },
      ],
      lookupFn: async () => memory,
      readEventsFn: emptyEvents,
      chat: async (_cfg, messages) => {
        const joined = messages.map((m) => m.content).join("\n");
        if (joined.includes("Score this lesson")) {
          const scores =
            judged++ === 0
              ? { reusable: 4, nonRedundancy: 2, grounding: 5 }
              : { reusable: 4, nonRedundancy: 5, grounding: 5 };
          return JSON.stringify({ scores, reason: "lessons/deploy-retries already states this rule." });
        }
        if (joined.includes("Extend the existing one")) {
          return JSON.stringify({
            reason: "adds the 4xx stop",
            new_facts: ["stop at a 4xx"],
            decision: "update",
            ref: "lessons/deploy-retries",
            body: `${existingBody}\n${newFact}`,
          });
        }
        return "---\ndescription: Prefer ripgrep over grep on large repos\nwhen_to_use: Searching for symbols across a multi-thousand-file repo\n---\n\nUse rg.\n";
      },
    });
    expect(result).toMatchObject({ outcome: "queued", updatesExisting: true });
    const content = await acceptedContent(stash);
    expect(content).toContain(newFact);
    expectForeign(content);
  });

  test("distill knowledge update", async () => {
    const stash = storage.stashDir;
    const knowledgePath = path.join(stash, "knowledge", "auth-guide.md");
    fs.writeFileSync(
      knowledgePath,
      `---\ndescription: Auth guide\nupdated: 2020-01-01\n${FOREIGN}---\n\nOld auth content.\n`,
    );
    const memory = path.join(stash, "memories", "auth-guide.md");
    fs.writeFileSync(
      memory,
      "---\ndescription: VPN required\nsource: skill:deploy\nobserved_at: 2026-04-21\nconfidence: 0.95\nscope_user: alice\n---\n\nUpdated auth tips.\n",
    );
    const result = await akmDistill({
      ref: "memories/auth-guide",
      proposalKind: "auto",
      config: distillConfig(stash, false),
      stashDir: stash,
      lookupFn: async (ref: string) => (ref === "memories/auth-guide" ? memory : knowledgePath),
      readEventsFn: positiveEvents,
      chat: async () =>
        JSON.stringify({ action: "UPDATE", content: "---\ndescription: Auth guide v2\n---\nMerged auth content.\n" }),
    });
    expect(result.outcome).toBe("queued");
    const content = await acceptedContent(stash);
    expect(content).toContain("Merged auth content");
    expect(parseFrontmatter(content).data.description).toBe("Auth guide v2");
    expect(parseFrontmatter(content).data.updated).not.toBe("2020-01-01");
    expectForeign(content);
  });
});
