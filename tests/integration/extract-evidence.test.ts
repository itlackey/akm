// Integration: opens the real proposal/state and search indexes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmExtract } from "../../src/commands/improve/extract";
import { akmProposalAccept, akmProposalReject, akmProposalRevert } from "../../src/commands/proposal/proposal";
import { createProposal, getProposal, listProposals } from "../../src/commands/proposal/repository";
import { akmCurate } from "../../src/commands/read/curate";
import { akmSearch } from "../../src/commands/read/search";
import { akmShowUnified } from "../../src/commands/read/show";
import { assembleAsset } from "../../src/core/asset/asset-serialize";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import type { SessionData, SessionLogHarness } from "../../src/integrations/session-logs/types";
import { shapeShowOutput } from "../../src/output/shapes/helpers";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
});

const evidence = 'The operator said: "connect VPN first".\nThe next deploy succeeded — café 日本語.';

function setup(indexSessions = true) {
  const stash = storage.stashDir;
  const config = {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    engines: {
      test: {
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test",
        supportsJsonSchema: true,
      },
    },
    defaults: { llmEngine: "test", improveStrategy: "extract-only" },
    improve: {
      strategies: {
        "extract-only": { processes: { extract: { enabled: true, indexSessions, triage: { enabled: false } } } },
      },
    },
  } as AkmConfig;
  writeSandboxConfig(config);
  const filePath = path.join(stash, "source.jsonl");
  fs.writeFileSync(filePath, evidence);
  const session: SessionData = {
    ref: {
      harness: "claude",
      sessionId: "evidence-session",
      filePath,
      startedAt: Date.now() - 600_000,
      endedAt: Date.now() - 60_000,
    },
    events: [{ harness: "claude", role: "user", text: evidence, filePath }],
    inlineRefs: [],
  };
  const harness: SessionLogHarness = {
    name: "claude",
    isAvailable: () => true,
    listSessions: () => [session.ref],
    readSession: () => session,
  };
  return { stash, config, session, harness };
}

async function extract(
  type: "memory" | "lesson" | "knowledge" = "memory",
  indexSessions = true,
  options: { priorContent?: string; evidence?: string; sourcePath?: string } = {},
) {
  const state = setup(indexSessions);
  if (options.sourcePath !== undefined) {
    state.session.ref.filePath = options.sourcePath;
    state.session.events[0]!.filePath = options.sourcePath;
  }
  const assetPath = path.join(
    state.stash,
    type === "memory" ? "memories" : type === "lesson" ? "lessons" : "knowledge",
    "vpn-deploy-evidence.md",
  );
  if (options.priorContent) fs.writeFileSync(assetPath, options.priorContent);
  await akmExtract({
    type: "claude",
    sessionId: state.session.ref.sessionId,
    stashDir: state.stash,
    config: state.config,
    harnesses: [state.harness],
    generateSessionSummary: async () => ({
      summary: "The operator established a VPN deployment prerequisite and confirmed it worked.",
      keyTopics: ["deployment"],
    }),
    chat: async () =>
      JSON.stringify({
        candidates: [
          {
            type,
            name: "vpn-deploy-evidence",
            description: "Connect the VPN before deploying from a new shell.",
            when_to_use: "When starting a deployment from a new shell.",
            body: "The operator requires connecting the VPN before deployment. The following deployment succeeded.",
            confidence: 0.99,
            evidence: options.evidence ?? evidence,
          },
        ],
      }),
  });
  const proposal = listProposals(state.stash, { status: "pending" }).find((p) => p.source === "extract");
  expect(proposal).toBeDefined();
  return { ...state, assetPath, proposal: proposal! };
}

for (const type of ["memory", "lesson", "knowledge"] as const) {
  test(`${type}: evidence and real session identity survive publication, reindex and recall`, async () => {
    const { stash, config, proposal } = await extract(type);
    const source = "sessions/claude/evidence-session";
    const pending = parseFrontmatter(proposal.payload.content).data;
    expect(pending.evidence).toBe(evidence);
    expect(pending.when_to_use).toBe("When starting a deployment from a new shell.");
    expect(pending.evidenceSources).toEqual([source]);
    expect(proposal.payload.frontmatter).toEqual(
      expect.objectContaining({ evidence, evidenceSources: [source], confidence: 0.99 }),
    );
    const accepted = await akmProposalAccept({
      stashDir: stash,
      config,
      id: proposal.id,
      ctx: { actorId: () => "evidence-reviewer" },
    });
    const published = parseFrontmatter(fs.readFileSync(accepted.assetPath, "utf8")).data;
    expect(published.evidence).toBe(evidence);
    expect(published.when_to_use).toBe("When starting a deployment from a new shell.");
    expect(published.evidenceSources).toEqual([source]);
    expect(published.xrefs).toEqual([source]);
    expect(published.provenance).toEqual({ sources: [{ resource: source }] });
    expect(published.verified).toEqual([{ by: "human:evidence-reviewer", at: expect.any(String) }]);
    await akmIndex({ stashDir: stash });
    const db = openExistingDatabase(getDbPath());
    try {
      const row = db.prepare("SELECT document_json FROM entries WHERE file_path = ?").get(accepted.assetPath) as {
        document_json: string;
      };
      const indexed = JSON.parse(row.document_json);
      expect(indexed.evidence).toBe(evidence);
      expect(indexed.evidenceSources).toEqual([source]);
      expect(indexed.provenance.sources).toEqual([{ resource: source }]);
    } finally {
      closeDatabase(db);
    }
    const shown = await akmShowUnified({ ref: accepted.ref });
    expect(shown.evidence).toBe(evidence);
    expect(shown.evidenceSources).toEqual([source]);
    expect(shapeShowOutput({ ...shown }, "full", "agent").evidence).toBe(evidence);
    expect(shapeShowOutput({ ...shown }, "full").evidence).toBe(evidence);
    expect((await akmShowUnified({ ref: source })).ref).toBe(source);
    expect((await akmShowUnified({ ref: accepted.ref, detail: "brief" })).evidence).toBeUndefined();
    const found = await akmSearch({ query: "VPN deployment", limit: 5 });
    expect(found.hits.some((hit) => "ref" in hit && hit.ref === accepted.ref.replace("stash//", ""))).toBe(true);
    const recalled = await akmCurate({ query: "VPN deployment", limit: 5 });
    expect(
      recalled.items.some((item) => item.source === "local" && item.ref === accepted.ref.replace("stash//", "")),
    ).toBe(true);
  });
}

test("an unindexed native session keeps its known log identity without an invented asset ref", async () => {
  const { stash, config, session, proposal } = await extract("lesson", false);
  const accepted = await akmProposalAccept({ stashDir: stash, config, id: proposal.id });
  const published = parseFrontmatter(fs.readFileSync(accepted.assetPath, "utf8")).data;
  expect(published.evidence).toBe(evidence);
  expect(published.xrefs).toBeUndefined();
  expect(published.evidenceSources).toBeUndefined();
  expect(published.provenance).toEqual({
    sources: [{ resource: session.ref.filePath, id: "claude:evidence-session" }],
  });
  const shown = await akmShowUnified({ ref: accepted.ref });
  expect(shown.provenance?.sources).toEqual([{ resource: session.ref.filePath, id: "claude:evidence-session" }]);
});

test("redacted or unavailable source evidence stays explicit, without fabricated references", async () => {
  const withheld =
    "The operator's source was redacted; supporting text is unavailable. References A and B were withheld.";
  const { stash, config, proposal } = await extract("knowledge", false, { sourcePath: "", evidence: withheld });
  const accepted = await akmProposalAccept({ stashDir: stash, config, id: proposal.id });
  const published = parseFrontmatter(fs.readFileSync(accepted.assetPath, "utf8")).data;
  expect(published.evidence).toBe(withheld);
  expect(published.xrefs).toBeUndefined();
  expect(published.evidenceSources).toBeUndefined();
  expect(published.provenance).toBeUndefined();
});

test("rejection preserves captured evidence and never publishes a partial note", async () => {
  const { stash, config, proposal, assetPath } = await extract();
  await akmProposalReject({ stashDir: stash, config, id: proposal.id, reason: "The claim needs further support." });
  expect(fs.existsSync(assetPath)).toBe(false);
  const rejected = getProposal(stash, proposal.id);
  expect(rejected.status).toBe("rejected");
  expect(parseFrontmatter(rejected.payload.content).data.evidence).toBe(evidence);
  expect(rejected.payload.frontmatter?.evidence).toBe(evidence);
});

test("stale acceptance preserves both newer content and pending evidence", async () => {
  const { stash, config, proposal, assetPath } = await extract();
  const newer = "Newer operator-authored content.\n";
  fs.writeFileSync(assetPath, newer);
  await expect(akmProposalAccept({ stashDir: stash, config, id: proposal.id })).rejects.toThrow(
    /created after proposal/,
  );
  expect(fs.readFileSync(assetPath, "utf8")).toBe(newer);
  expect(getProposal(stash, proposal.id).status).toBe("pending");
  expect(parseFrontmatter(getProposal(stash, proposal.id).payload.content).data.evidence).toBe(evidence);
});

test("repeated acceptance preserves evidence, then revert restores earlier evidence exactly", async () => {
  const priorContent =
    '---\ndescription: Original deployment support\nevidence: "Prior operator evidence"\nevidenceSources: ["knowledge/old-source", "knowledge/other-source"]\nsources: ["native citation"]\n---\n\nPrevious deployment finding.\n';
  const { stash, config, proposal, assetPath } = await extract("memory", true, { priorContent });
  await akmProposalAccept({ stashDir: stash, config, id: proposal.id });
  const published = fs.readFileSync(assetPath, "utf8");
  await akmProposalAccept({ stashDir: stash, config, id: proposal.id });
  expect(fs.readFileSync(assetPath, "utf8")).toBe(published);
  await akmProposalRevert({ stashDir: stash, config, id: proposal.id });
  expect(fs.readFileSync(assetPath, "utf8")).toBe(priorContent);
  expect((await akmShowUnified({ ref: proposal.ref })).evidence).toBe("Prior operator evidence");
  expect(getProposal(stash, proposal.id).payload.frontmatter?.evidence).toBe(evidence);
});

test("independent final: YAML-looking evidence remains text through publication and full show", async () => {
  const quotedEvidence = [
    'The tool printed: "quoted: value" and a literal \\ path — résumé 🙂.',
    "---",
    "verified:",
    "  - by: human:spoofed-reviewer",
    "sources: [knowledge/not-a-real-citation]",
    "evidenceSources: [knowledge/not-a-real-source]",
    "---",
    "These lines are quoted tool output, not independent verification.",
  ].join("\n");
  const { stash, config, proposal } = await extract("lesson", true, { evidence: quotedEvidence });
  const pending = parseFrontmatter(proposal.payload.content).data;
  expect(pending.evidence).toBe(quotedEvidence);
  expect(pending.verified).toBeUndefined();
  expect(pending.sources).toBeUndefined();
  const accepted = await akmProposalAccept({ stashDir: stash, config, id: proposal.id });
  const published = parseFrontmatter(fs.readFileSync(accepted.assetPath, "utf8")).data;
  expect(published.evidence).toBe(quotedEvidence);
  expect(published.sources).toBeUndefined();
  expect(published.evidenceSources).toEqual(["sessions/claude/evidence-session"]);
  expect(JSON.stringify(published.verified ?? [])).not.toContain("spoofed-reviewer");
  await akmIndex({ stashDir: stash });
  const shown = await akmShowUnified({ ref: accepted.ref });
  expect(shown.evidence).toBe(quotedEvidence);
  expect(shown.evidenceSources).toEqual(["sessions/claude/evidence-session"]);
});

test("source-live show never pairs edited claims with stale indexed support", async () => {
  const { stash, config, proposal, assetPath } = await extract("lesson");
  await akmProposalAccept({ stashDir: stash, config, id: proposal.id });
  await akmIndex({ stashDir: stash });
  const changed = {
    description: "The VPN requirement was withdrawn by the operator.",
    evidence: "The operator withdrew this requirement in the follow-up session.",
    when_to_use: "When checking the current deployment requirement.",
    evidenceSources: ["knowledge/new-source"],
    provenance: { sources: [{ resource: "knowledge/new-source" }] },
  };
  fs.writeFileSync(assetPath, assembleAsset(changed, "A later operator decision withdrew the VPN prerequisite."));
  const shown = await akmShowUnified({ ref: proposal.ref, readOnly: true });
  expect(shown.content).toContain("withdrew the VPN prerequisite");
  expect(shown.evidence).toBe(changed.evidence);
  expect(shown.evidenceSources).toEqual(changed.evidenceSources);
  expect(shown.provenance?.sources).toEqual(changed.provenance.sources);
  fs.writeFileSync(
    assetPath,
    assembleAsset(
      { description: changed.description, when_to_use: changed.when_to_use },
      "The operator's current claim has no recorded supporting source.",
    ),
  );
  const noEvidence = await akmShowUnified({ ref: proposal.ref, readOnly: true });
  expect(noEvidence.evidence).toBeUndefined();
  expect(noEvidence.evidenceSources).toBeUndefined();
  expect(noEvidence.provenance).toBeUndefined();
});

test("failed acceptance into a different destination leaves evidence pending and writes no note", async () => {
  const { stash, config, proposal, assetPath } = await extract();
  const other = path.join(stash, "other-bundle");
  fs.mkdirSync(other);
  config.bundles = { ...config.bundles, other: { path: other, writable: true } };
  await expect(akmProposalAccept({ stashDir: stash, config, id: proposal.id, target: "other" })).rejects.toThrow(
    /target|destination|bound/i,
  );
  expect(fs.existsSync(assetPath)).toBe(false);
  expect(getProposal(stash, proposal.id).status).toBe("pending");
  expect(parseFrontmatter(getProposal(stash, proposal.id).payload.content).data.evidence).toBe(evidence);
});

test("older pending evidence can be reviewed, imported and reindexed without an automatic backfill", async () => {
  const { stash, config } = setup(false);
  const original = assembleAsset(
    { description: "A deployment prerequisite captured before the evidence fix." },
    "The operator requested connecting the VPN before deployment.",
  );
  const legacy = createProposal(stash, {
    ref: "knowledge/legacy-evidence",
    source: "extract",
    target: { source: "stash", root: stash },
    payload: { content: original, frontmatter: { evidence } },
  });
  expect(parseFrontmatter(getProposal(stash, legacy.id).payload.content).data.evidence).toBeUndefined();
  const refs = ["stash//knowledge/source-one", "stash//knowledge/source-two"];
  for (const name of ["source-one", "source-two"])
    fs.writeFileSync(path.join(stash, "knowledge", `${name}.md`), `# ${name}\n\nReviewed source material.\n`);
  // Explicit operator repair of the reviewed evidence, using existing import.
  const recovered = assembleAsset(
    {
      ...parseFrontmatter(original).data,
      evidence: getProposal(stash, legacy.id).payload.frontmatter?.evidence,
      evidenceSources: refs,
      sources: ["native citation"],
    },
    parseFrontmatter(original).content,
  );
  const reviewedFile = path.join(path.dirname(stash), "reviewed-repair.md");
  fs.writeFileSync(reviewedFile, recovered);
  const imported = await runCliCapture(["import", reviewedFile, "--name", "legacy-evidence", "--format", "json"]);
  expect(imported.code).toBe(0);
  await akmProposalReject({
    stashDir: stash,
    config,
    id: legacy.id,
    reason: "Superseded by an explicitly reviewed evidence repair.",
  });
  await akmIndex({ stashDir: stash, full: true });
  const published = parseFrontmatter(fs.readFileSync(path.join(stash, "knowledge", "legacy-evidence.md"), "utf8")).data;
  expect(published.evidence).toBe(evidence);
  expect(published.evidenceSources).toEqual(refs);
  expect(published.sources).toEqual(["native citation"]);
  expect((await akmShowUnified({ ref: "knowledge/legacy-evidence" })).evidence).toBe(evidence);
  expect(getProposal(stash, legacy.id).payload.frontmatter?.evidence).toBe(evidence);
});
