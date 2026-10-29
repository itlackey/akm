// Integration: exercises the real proposal/state database and publication/archive paths.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { emitPromotionProposal, type PromoteContext } from "../../../../src/commands/improve/consolidate";
import { contentHash } from "../../../../src/commands/improve/content-hash";
import { akmProposalAccept } from "../../../../src/commands/proposal/proposal";
import { createProposal, getProposal, proposalContent } from "../../../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../../../src/core/asset/frontmatter";
import { resolveWriteTarget } from "../../../../src/core/write-source";
import { makeConfig } from "../../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
});

const keys = ["user", "agent", "run", "channel"] as const;
const scope = Object.fromEntries(keys.map((key) => [`scope_${key}`, `original-${key}`]));
const fm = keys.map((key) => `scope_${key}: original-${key}`).join("\n");
const body =
  "The Larch recovery service requires the offline vault key from the custodian. Run the recovery check before restoring the backup, and retain the recovery log for seven days.\n";

function setup() {
  const config = makeConfig(storage.stashDir);
  const file = path.join(storage.stashDir, "memories/source.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: Larch recovery\n${fm}\nxrefs: [knowledge/recovery-guide]\n---\n${body}`);
  const ctx: PromoteContext = {
    config,
    stashDir: storage.stashDir,
    sourceRun: "scope-test",
    target: resolveWriteTarget(config),
    memoryByRef: new Map([
      [
        "memories/source",
        { name: "source", filePath: file, description: "Larch recovery", tags: [], stashDir: storage.stashDir },
      ],
    ]),
    promoted: [],
    promotedSourceRefs: new Set(),
    existingKnowledgeBodyHashes: new Set(),
    promotionFailures: { count: 0 },
    warnings: [],
    pushSkipReason: () => {},
  };
  return { config, file, ctx };
}
async function promote(ctx: PromoteContext) {
  await emitPromotionProposal(
    {
      op: "promote",
      ref: "memories/source",
      knowledgeRef: "knowledge/recovery",
      reason: "durable recovery",
      description: "Larch recovery",
    },
    ctx,
  );
  expect(ctx.promoted).toHaveLength(1);
  return getProposal(storage.stashDir, ctx.promoted[0]!);
}

describe("promotion scope preservation (#1197)", () => {
  test("real writer and accepted output retain all scopes, body and source evidence", async () => {
    const { config, file, ctx } = setup();
    const proposal = await promote(ctx);
    expect(parseFrontmatter(proposalContent(proposal)).data).toMatchObject(scope);
    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    const output = parseFrontmatter(fs.readFileSync(result.assetPath, "utf8"));
    expect(output.data).toMatchObject(scope);
    expect(output.content.trim()).toBe(body.trim());
    expect(output.data.xrefs).toContain("memories/source");
    expect(output.data.xrefs).toContain("knowledge/recovery-guide");
    expect(fs.existsSync(file)).toBe(false);
  });

  for (const key of keys)
    test(`scope-only source ${key} edit refuses publication and archival`, async () => {
      const { config, file, ctx } = setup();
      const proposal = await promote(ctx);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`original-${key}`, `changed-${key}`));
      await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
        /scope/i,
      );
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.existsSync(path.join(storage.stashDir, "knowledge/recovery.md"))).toBe(false);
      expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
    });

  test("an older promotion with scope erased cannot publish or retire a scoped source", async () => {
    const { config, file } = setup();
    const proposal = createProposal(storage.stashDir, {
      source: "consolidate",
      ref: "knowledge/recovery",
      payload: {
        content: `---\ndescription: Larch recovery\n---\n${body}`,
        frontmatter: { description: "Larch recovery" },
      },
      promotionSource: "memories/source",
      promotionSourceHash: contentHash(fs.readFileSync(file, "utf8"), "body"),
    });
    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(/scope/i);
    expect(fs.existsSync(file)).toBe(true);
  });

  test("a differently scoped derived twin survives promotion archive", async () => {
    const { config, file, ctx } = setup();
    const twin = file.replace(/\.md$/, ".derived.md");
    const original = fs.readFileSync(file, "utf8").replace("original-user", "other-user");
    fs.writeFileSync(twin, original);
    const proposal = await promote(ctx);
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(fs.readFileSync(twin, "utf8")).toBe(original);
  });
});
