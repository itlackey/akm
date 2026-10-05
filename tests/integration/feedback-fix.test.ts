import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { applyExactReplacements, assertProposalWritesFile } from "../../src/commands/feedback-cli";
import { getProposal, listProposals } from "../../src/commands/proposal/repository";
import { saveConfig } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

// `akm feedback --negative ... --replace/--with/--source`: an exact fix for a
// wrong fact in an asset's text, checked before anything is recorded and filed
// as a proposal for review.

let storage: IsolatedAkmStorage;
let stashDir = "";
const NOTE =
  "---\ndescription: OpenCode server notes\n---\n# OpenCode\n\nThe server listens on port 8000 by default.\n";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
});

afterEach(() => {
  storage.cleanup();
  stashDir = "";
});

/** Write `files` (stash-relative path to content), make the stash the only bundle, and index it. */
async function indexFiles(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(stashDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
  });
  await akmIndex({ stashDir, full: true });
}

async function indexNote(content = NOTE): Promise<string> {
  await indexFiles({ "knowledge/opencode-server.md": content });
  return path.join(stashDir, "knowledge", "opencode-server.md");
}

async function feedback(
  args: string[],
  ref = "knowledge/opencode-server",
): Promise<{ code: number | null; json: Record<string, unknown> }> {
  const { stdout, stderr, code } = await runCliCapture(["feedback", ref, "--negative", "--format=json", ...args]);
  return { code, json: JSON.parse(stdout.trim() || stderr.trim()) as Record<string, unknown> };
}

function feedbackEvents(): number {
  const db = openStateDatabase();
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE event_type = 'feedback'").get() as { n: number })
      .n;
  } finally {
    db.close();
  }
}

const FIX = [
  "--reason",
  "The default port is 4096, not 8000.",
  "--replace",
  "port 8000",
  "--with",
  "port 4096",
  "--source",
  "https://opencode.ai/docs/server/",
];

describe("akm feedback --replace/--with/--source", () => {
  test("files the exact fix as a proposal and leaves the file alone until it is accepted", async () => {
    const file = await indexNote();
    const { code, json } = await feedback(FIX);
    expect(code).toBe(0);
    const fix = json.fix as { proposalId: string; replacements: number; source: string };
    expect(fix).toMatchObject({ replacements: 1, source: "https://opencode.ai/docs/server/" });

    const proposal = getProposal(stashDir, fix.proposalId);
    expect(proposal.source).toBe("feedback");
    expect(proposal.feedback).toEqual({
      reason: "The default port is 4096, not 8000.",
      source: "https://opencode.ai/docs/server/",
    });
    expect(proposal.payload.content).toContain("listens on port 4096 by default");
    expect(proposal.payload.content).not.toContain("8000");
    expect(fs.readFileSync(file, "utf8")).toBe(NOTE);
    expect(feedbackEvents()).toBe(1);

    const accepted = await runCliCapture(["proposal", "accept", fix.proposalId, "--format=json"]);
    expect(accepted.code).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toContain("The server listens on port 4096 by default.");
  });

  test("applies several pairs in order, and takes a value that starts with a dash", async () => {
    await indexNote("---\ndescription: OpenCode server notes\n---\n# OpenCode\n\n- port: 8000\n- mcp: server\n");
    const { code, json } = await feedback([
      "--reason",
      "Two facts are wrong.",
      "--replace",
      "- port: 8000",
      "--with",
      "- port: 4096",
      "--replace",
      "- mcp: server",
      "--with=- mcp: status route",
      "--source",
      "opencode serve --help",
    ]);
    expect(code).toBe(0);
    const proposal = getProposal(stashDir, (json.fix as { proposalId: string }).proposalId);
    expect(proposal.payload.content).toContain("- port: 4096\n- mcp: status route\n");
  });

  test("text that is not in the file records nothing", async () => {
    await indexNote();
    const { code, json } = await feedback([
      ...FIX.slice(0, 2),
      "--replace",
      "port 9999",
      "--with",
      "x",
      "--source",
      "y",
    ]);
    expect(code).not.toBe(0);
    expect(String(json.error)).toContain("--replace #1 was not found");
    expect(feedbackEvents()).toBe(0);
    expect(listProposals(stashDir, { status: "pending" })).toHaveLength(0);
  });

  test("text that appears more than once records nothing, and names the lines", async () => {
    await indexNote("---\ndescription: d\n---\n# T\n\nport 8000 here\n\nand port 8000 there\n");
    const { code, json } = await feedback(FIX);
    expect(code).not.toBe(0);
    expect(String(json.error)).toContain("appears 2 times");
    expect(String(json.error)).toContain("lines 6, 8");
    expect(feedbackEvents()).toBe(0);
  });

  test("a fix that breaks the frontmatter records nothing", async () => {
    await indexNote();
    const { code, json } = await feedback([
      "--reason",
      "Wrong description.",
      "--replace",
      "description: OpenCode server notes",
      "--with",
      "description: OpenCode: server notes",
      "--source",
      "https://opencode.ai/docs/server/",
    ]);
    expect(code).not.toBe(0);
    expect(String(json.error)).toContain("breaks the frontmatter");
    expect(feedbackEvents()).toBe(0);
  });

  test("the flags are checked before anything else", async () => {
    await indexNote();
    const noWith = await feedback(["--reason", "r", "--replace", "port 8000", "--source", "s"]);
    expect(String(noWith.json.error)).toContain("Each --replace needs one --with");
    const noSource = await feedback(["--reason", "r", "--replace", "port 8000", "--with", "port 4096"]);
    expect(String(noSource.json.error)).toContain("needs --source");
    const positive = await runCliCapture([
      "feedback",
      "knowledge/opencode-server",
      "--positive",
      "--replace",
      "port 8000",
      "--with",
      "port 4096",
      "--source",
      "s",
      "--format=json",
    ]);
    expect(positive.code).not.toBe(0);
    expect(positive.stdout + positive.stderr).toContain("only for negative feedback");
    expect(feedbackEvents()).toBe(0);
  });
});

describe("a fix for a file a proposal would not write", () => {
  // An asset indexed outside its type's directory: the path the proposal would
  // write does not exist, so accepting it would create a duplicate and fix nothing.
  test.each([
    ["a bundle's tasks/README", "tasks/README.md", "knowledge/tasks/README"],
    [
      "a skill's reference file",
      "skills/deploy/references/symptom-map.md",
      "knowledge/skills/deploy/references/symptom-map",
    ],
  ])("%s is refused, and nothing is recorded", async (_label, rel, ref) => {
    await indexFiles({
      "skills/deploy/SKILL.md": "---\ndescription: Deploy\n---\n# Deploy\n",
      [rel]: "---\ndescription: Notes\n---\n# Notes\n\nThe server listens on port 8000 by default.\n",
    });
    const { code, json } = await feedback(FIX, ref);
    expect(code).not.toBe(0);
    const wouldWrite = path.join(stashDir, `${ref}.md`);
    expect(json.error).toBe(
      `akm cannot queue a fix for stash//${ref}: its file is ${path.join(stashDir, rel)}, but a proposal would write ${wouldWrite}. Edit the file directly.`,
    );
    expect(feedbackEvents()).toBe(0);
    expect(listProposals(stashDir, { status: "pending" })).toHaveLength(0);
    expect(fs.existsSync(wouldWrite)).toBe(false);
  });

  test("plain negative feedback on such an asset is still recorded", async () => {
    await indexFiles({ "tasks/README.md": "---\ndescription: Tasks\n---\n# Tasks\n" });
    const { code } = await feedback(["--reason", "The page is out of date."], "knowledge/tasks/README");
    expect(code).toBe(0);
    expect(feedbackEvents()).toBe(1);
  });
});

describe("assertProposalWritesFile", () => {
  const root = path.join(path.sep, "bundle");

  test("passes when the proposal would write the asset's file", () => {
    expect(() =>
      assertProposalWritesFile("b//knowledge/guide", root, path.join(root, "knowledge", "guide.md")),
    ).not.toThrow();
    expect(() =>
      assertProposalWritesFile("b//skills/deploy", root, path.join(root, "skills", "deploy", "SKILL.md")),
    ).not.toThrow();
  });

  test("names both paths when it would write somewhere else", () => {
    expect(() =>
      assertProposalWritesFile("b//knowledge/tasks/README", root, path.join(root, "tasks", "README.md")),
    ).toThrow(
      `akm cannot queue a fix for b//knowledge/tasks/README: its file is ${path.join(root, "tasks", "README.md")}, but a proposal would write ${path.join(root, "knowledge", "tasks", "README.md")}. Edit the file directly.`,
    );
  });

  test("refuses an asset whose type has no directory to write into", () => {
    expect(() =>
      assertProposalWritesFile("b//tables/customers", root, path.join(root, "tables", "customers.md")),
    ).toThrow("akm has no directory for");
  });
});

describe("applyExactReplacements", () => {
  test("each pair sees the text the previous pair produced", () => {
    expect(
      applyExactReplacements(
        "a b c",
        [
          { old: "a", new: "x" },
          { old: "x b", new: "y" },
        ],
        "f.md",
      ),
    ).toBe("y c");
  });

  test("an empty --replace is refused", () => {
    expect(() => applyExactReplacements("abc", [{ old: "", new: "x" }], "f.md")).toThrow(UsageError);
  });
});
