import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { applyExactReplacements, applyHistoryMark, assertProposalWritesFile } from "../../src/commands/feedback-cli";
import { writeSupersededEdge } from "../../src/commands/improve/memory/memory-belief";
import { getProposal, listProposals } from "../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { saveConfig } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { readEvents } from "../../src/core/events";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

// `akm feedback --negative ... --replace/--with/--source`: an exact fix for a
// wrong fact in an asset's text, checked before anything is recorded and filed
// as a proposal for review. `--superseded-by <ref>` and `--outdated` mark the
// asset's history the same way, in the same proposal.

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

describe("akm feedback --superseded-by / --outdated", () => {
  // `type` and `updated` are there so that filing the proposal adds nothing of its own.
  const OLD = [
    "---",
    "type: knowledge",
    "updated: 2026-10-01",
    "# kept comment",
    "description: OpenCode server notes",
    "---",
    "# OpenCode",
    "",
    "The server listens on port 8000 by default.",
    "",
  ].join("\n");
  const NEW = "---\ndescription: The current OpenCode server notes\n---\n# OpenCode\n";
  const REASON = ["--reason", "A newer note replaces this one."];
  const SOURCE = ["--source", "knowledge/new-note"];
  const SUCCESSOR = "stash//knowledge/new-note";

  async function indexPair(old = OLD): Promise<string> {
    await indexFiles({ "knowledge/opencode-server.md": old, "knowledge/new-note.md": NEW });
    return path.join(stashDir, "knowledge", "opencode-server.md");
  }

  test("--superseded-by files beliefState and supersededBy in one proposal, and the rest of the file is as it was", async () => {
    const file = await indexPair();
    const { code, json } = await feedback([...REASON, ...SOURCE, "--superseded-by", "knowledge/new-note"]);
    expect(code).toBe(0);
    expect(json.fix).toEqual({
      proposalId: expect.any(String),
      replacements: 0,
      source: "knowledge/new-note",
      beliefState: "superseded",
      supersededBy: SUCCESSOR,
    });

    const proposals = listProposals(stashDir, { status: "pending" });
    expect(proposals).toHaveLength(1);
    const proposal = getProposal(stashDir, (json.fix as { proposalId: string }).proposalId);
    expect(proposal.source).toBe("feedback");
    expect(proposal.payload.content).toBe(
      OLD.replace("---\n# OpenCode", `beliefState: superseded\nsupersededBy:\n  - ${SUCCESSOR}\n---\n# OpenCode`),
    );
    expect(fs.readFileSync(file, "utf8")).toBe(OLD);
    expect(feedbackEvents()).toBe(1);
    expect(
      readEvents({ type: "feedback", ref: "stash//knowledge/opencode-server" }).events.at(-1)?.metadata?.fix,
    ).toEqual({
      source: "knowledge/new-note",
      replacements: 0,
      beliefState: "superseded",
      supersededBy: SUCCESSOR,
    });

    const accepted = await runCliCapture(["proposal", "accept", proposal.id, "--format=json"]);
    expect(accepted.code).toBe(0);
    expect(parseFrontmatter(fs.readFileSync(file, "utf8")).data).toMatchObject({
      beliefState: "superseded",
      supersededBy: [SUCCESSOR],
    });
  });

  test("repeating it on an asset that already says so changes nothing and records nothing more", async () => {
    await indexPair();
    const args = [...REASON, ...SOURCE, "--superseded-by", "knowledge/new-note"];
    const first = await feedback(args);
    const accepted = await runCliCapture([
      "proposal",
      "accept",
      (first.json.fix as { proposalId: string }).proposalId,
      "--format=json",
    ]);
    expect(accepted.code).toBe(0);

    const again = await feedback(args);
    expect(again.code).not.toBe(0);
    expect(String(again.json.error)).toContain("The fix changes nothing");
    expect(feedbackEvents()).toBe(1);
    expect(listProposals(stashDir, { status: "pending" })).toHaveLength(0);
  });

  test("--outdated files beliefState: deprecated, and no supersededBy", async () => {
    const file = await indexPair();
    const { code, json } = await feedback([...REASON, ...SOURCE, "--outdated"]);
    expect(code).toBe(0);
    expect(json.fix).toEqual({
      proposalId: expect.any(String),
      replacements: 0,
      source: "knowledge/new-note",
      beliefState: "deprecated",
    });
    const proposal = getProposal(stashDir, (json.fix as { proposalId: string }).proposalId);
    expect(proposal.payload.content).toBe(OLD.replace("---\n# OpenCode", "beliefState: deprecated\n---\n# OpenCode"));
    expect(fs.readFileSync(file, "utf8")).toBe(OLD);
  });

  test("--outdated on an asset that is already superseded changes nothing", async () => {
    await indexPair(OLD.replace("description:", "beliefState: superseded\ndescription:"));
    const { code, json } = await feedback([...REASON, ...SOURCE, "--outdated"]);
    expect(code).not.toBe(0);
    expect(String(json.error)).toContain("The fix changes nothing");
    expect(feedbackEvents()).toBe(0);
  });

  test("--superseded-by together with --replace makes one proposal holding both changes", async () => {
    const file = await indexPair();
    const { code, json } = await feedback([...FIX, "--superseded-by", "knowledge/new-note"]);
    expect(code).toBe(0);
    expect(json.fix).toMatchObject({ replacements: 1, beliefState: "superseded", supersededBy: SUCCESSOR });

    expect(listProposals(stashDir, { status: "pending" })).toHaveLength(1);
    const proposal = getProposal(stashDir, (json.fix as { proposalId: string }).proposalId);
    expect(proposal.feedback).toEqual({
      reason: "The default port is 4096, not 8000.",
      source: "https://opencode.ai/docs/server/",
    });
    expect(proposal.payload.content).toContain("listens on port 4096 by default");
    expect(parseFrontmatter(proposal.payload.content).data).toMatchObject({
      beliefState: "superseded",
      supersededBy: [SUCCESSOR],
    });
    expect(feedbackEvents()).toBe(1);

    const accepted = await runCliCapture(["proposal", "accept", proposal.id, "--format=json"]);
    expect(accepted.code).toBe(0);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("listens on port 4096 by default");
    expect(parseFrontmatter(text).data).toMatchObject({ beliefState: "superseded", supersededBy: [SUCCESSOR] });
  });

  test.each([
    ["an unknown ref", ["--superseded-by", "knowledge/nope"], "is not in the index"],
    ["the asset itself", ["--superseded-by", "knowledge/opencode-server"], "is the asset itself"],
    ["the asset itself, qualified", ["--superseded-by", "stash//knowledge/opencode-server.md"], "is the asset itself"],
    ["an empty ref", ["--superseded-by", ""], "needs the ref"],
    ["two refs", ["--superseded-by", "knowledge/new-note", "--superseded-by", "knowledge/new-note"], "takes one ref"],
    ["both marks", ["--superseded-by", "knowledge/new-note", "--outdated"], "use one"],
  ])("%s is refused, and nothing is recorded", async (_label, flags, message) => {
    const file = await indexPair();
    const { code, json } = await feedback([...REASON, ...SOURCE, ...flags]);
    expect(code).not.toBe(0);
    expect(String(json.error)).toContain(message);
    expect(feedbackEvents()).toBe(0);
    expect(listProposals(stashDir, { status: "pending" })).toHaveLength(0);
    expect(fs.readFileSync(file, "utf8")).toBe(OLD);
  });

  test("the flags need --reason, --source and negative feedback, like every fix", async () => {
    await indexPair();
    const noSource = await feedback([...REASON, "--outdated"]);
    expect(String(noSource.json.error)).toContain("needs --source");
    const noReason = await feedback([...SOURCE, "--outdated"]);
    expect(String(noReason.json.error)).toContain("needs --reason");
    for (const flags of [["--outdated"], ["--superseded-by", "knowledge/new-note"]]) {
      const positive = await runCliCapture([
        "feedback",
        "knowledge/opencode-server",
        "--positive",
        ...flags,
        ...SOURCE,
        "--format=json",
      ]);
      expect(positive.code).not.toBe(0);
      expect(positive.stdout + positive.stderr).toContain("only for negative feedback");
    }
    expect(feedbackEvents()).toBe(0);
  });

  test.each([
    ["a script", "scripts/deploy.sh", "#!/bin/sh\necho hi\n", "scripts/deploy.sh"],
    ["an env file", "env/prod.env", "REGION=us-east-1\n", "env/prod"],
  ])("%s is not marked, because it has no frontmatter", async (_label, rel, content, ref) => {
    await indexFiles({ [rel]: content });
    const { code, json } = await feedback([...REASON, ...SOURCE, "--outdated"], ref);
    expect(code).not.toBe(0);
    expect(String(json.error)).toContain("is not one");
    expect(feedbackEvents()).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, rel), "utf8")).toBe(content);
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

describe("applyHistoryMark", () => {
  const REF = "b//knowledge/new";
  const superseded = { supersededBy: REF };
  const outdated = { outdated: true } as const;
  const doc = (frontmatter: string, body = "# Title\n\nBody.\n") => `---\n${frontmatter}\n---\n${body}`;
  const mark = (raw: string, m: Parameters<typeof applyHistoryMark>[1] = superseded) =>
    applyHistoryMark(raw, m, "f.md");

  test("adds both fields before the closing fence and keeps every other byte", () => {
    const keep = "# a comment\ndescription: 'Quoted'\ntags: [b, a]\nwhen_to_use: |\n  Block\n  text";
    expect(mark(doc(keep))).toBe(doc(`${keep}\nbeliefState: superseded\nsupersededBy:\n  - ${REF}`));
  });

  test("replaces an existing beliefState line where it stands", () => {
    expect(mark(doc("description: d\nbeliefState: active\ntags: [a]"))).toBe(
      doc(`description: d\nbeliefState: superseded\ntags: [a]\nsupersededBy:\n  - ${REF}`),
    );
    expect(mark(doc("description: d\nbeliefState: active\ntags: [a]"), outdated)).toBe(
      doc("description: d\nbeliefState: deprecated\ntags: [a]"),
    );
  });

  test.each([
    "contradicted",
    "archived",
  ])("%s stays when a successor is named, and the ref is still listed", (state) => {
    expect(mark(doc(`beliefState: ${state}`))).toBe(doc(`beliefState: ${state}\nsupersededBy:\n  - ${REF}`));
  });

  test.each(["deprecated", "superseded", "contradicted", "archived"])("--outdated leaves %s alone", (state) => {
    const raw = doc(`beliefState: ${state}`);
    expect(mark(raw, outdated)).toBe(raw);
  });

  test("--outdated and --superseded-by replace active and asserted states", () => {
    for (const state of ["active", "asserted", "unknown-state"]) {
      expect(parseFrontmatter(mark(doc(`beliefState: ${state}`), outdated)).data.beliefState).toBe("deprecated");
      expect(parseFrontmatter(mark(doc(`beliefState: ${state}`))).data.beliefState).toBe("superseded");
    }
  });

  test("a block list gets the ref after its last item, indented like it", () => {
    expect(mark(doc("supersededBy:\n  - b//knowledge/a\n  - b//knowledge/b\ntags: [x]"))).toBe(
      doc(`supersededBy:\n  - b//knowledge/a\n  - b//knowledge/b\n  - ${REF}\ntags: [x]\nbeliefState: superseded`),
    );
    expect(mark(doc("supersededBy:\n- b//knowledge/a\nbeliefState: superseded"))).toBe(
      doc(`supersededBy:\n- b//knowledge/a\n- ${REF}\nbeliefState: superseded`),
    );
    expect(mark(doc("supersededBy:\n  # reviewed\n  - b//knowledge/a\n\n  - b//knowledge/b\ntags: [x]"))).toBe(
      doc(
        `supersededBy:\n  # reviewed\n  - b//knowledge/a\n\n  - b//knowledge/b\n  - ${REF}\ntags: [x]\nbeliefState: superseded`,
      ),
    );
  });

  test("a scalar supersededBy is promoted to a list, and so is a flow list or an empty value", () => {
    for (const spelling of ["supersededBy: b//knowledge/a", "supersededBy: [b//knowledge/a]", "supersededBy:"]) {
      const expected = spelling.endsWith(":") ? [REF] : ["b//knowledge/a", REF];
      const marked = mark(doc(`${spelling}\ntags: [x]`));
      expect(parseFrontmatter(marked).data).toEqual({ beliefState: "superseded", supersededBy: expected, tags: ["x"] });
      expect(marked).toContain("tags: [x]\n");
    }
  });

  test("a ref that is already listed is not listed again, but the state is still set", () => {
    expect(mark(doc(`supersededBy: ${REF}\nbeliefState: active`))).toBe(
      doc(`supersededBy: ${REF}\nbeliefState: superseded`),
    );
  });

  test("repeating a mark changes nothing more", () => {
    for (const raw of [
      doc("description: d"),
      doc("supersededBy: b//knowledge/a"),
      doc("beliefState: contradicted"),
      doc("beliefState: archived\nsupersededBy: [b//knowledge/a]"),
      "# No frontmatter\n",
      doc("description: d").replace(/\n/g, "\r\n"),
    ]) {
      for (const m of [superseded, outdated]) {
        const once = mark(raw, m);
        expect(mark(once, m)).toBe(once);
      }
    }
  });

  test("a file without frontmatter gets a block, and its body is untouched", () => {
    expect(mark("# Title\n\nBody.\n")).toBe(
      doc(`beliefState: superseded\nsupersededBy:\n  - ${REF}`, "# Title\n\nBody.\n"),
    );
    expect(mark("# Title\n", outdated)).toBe(doc("beliefState: deprecated", "# Title\n"));
  });

  test("an empty frontmatter block, or one of only comments, is filled in", () => {
    expect(mark("---\n---\nBody\n", outdated)).toBe("---\nbeliefState: deprecated\n---\nBody\n");
    expect(mark("---\n# Nothing yet\n---\nBody\n", outdated)).toBe(
      "---\n# Nothing yet\nbeliefState: deprecated\n---\nBody\n",
    );
  });

  test("CRLF line endings stay CRLF", () => {
    const raw = doc("description: d").replace(/\n/g, "\r\n");
    expect(mark(raw)).toBe(
      doc(`description: d\nbeliefState: superseded\nsupersededBy:\n  - ${REF}`).replace(/\n/g, "\r\n"),
    );
  });

  test("a key spelled in a way a line edit cannot follow is handled by writing the frontmatter out again", () => {
    const marked = mark(doc('# gone\n"beliefState": active\ndescription: d\nsupersededBy: !!seq [b//knowledge/a]'));
    expect(parseFrontmatter(marked).data).toEqual({
      beliefState: "superseded",
      description: "d",
      supersededBy: ["b//knowledge/a", REF],
    });
    expect(marked.endsWith("\n---\n# Title\n\nBody.\n")).toBe(true);
  });

  test("a ref that needs quoting is quoted", () => {
    const awkward = "b//knowledge/note: with a colon";
    const marked = mark(doc("description: d"), { supersededBy: awkward });
    expect(parseFrontmatter(marked).data.supersededBy).toEqual([awkward]);
  });

  test("frontmatter that is not a YAML mapping is refused", () => {
    expect(() => mark(doc("description: [unclosed"))).toThrow(UsageError);
    expect(() => mark(doc("- a\n- b"))).toThrow("not a valid YAML mapping");
    expect(() => mark(doc("description: a\ndescription: b"))).toThrow("not a valid YAML mapping");
  });

  test("agrees with writeSupersededEdge on what a successor does to the frontmatter", () => {
    const file = path.join(stashDir, "parity.md");
    for (const frontmatter of [
      "description: d",
      "beliefState: active",
      "beliefState: contradicted\nsupersededBy: [b//knowledge/a]",
      "beliefState: archived",
      "supersededBy: b//knowledge/a",
      `supersededBy:\n  - ${REF}`,
      `beliefState: superseded\nsupersededBy: [${REF}]`,
    ]) {
      const raw = doc(frontmatter);
      fs.writeFileSync(file, raw);
      writeSupersededEdge(file, REF);
      // writeSupersededEdge sorts the list; a line edit appends, so compare the lists sorted.
      const sorted = (data: Record<string, unknown>) => ({
        ...data,
        supersededBy: [...(data.supersededBy as string[])].sort(),
      });
      const expected = parseFrontmatter(fs.readFileSync(file, "utf8")).data;
      expect(sorted(parseFrontmatter(mark(raw)).data)).toEqual(sorted(expected));
    }
  });
});
