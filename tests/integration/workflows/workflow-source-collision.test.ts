import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../../src/commands/read/show";
import { parseBundleRef } from "../../../src/core/asset/asset-ref";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex, lookupBundleRef } from "../../../src/indexer/indexer";
import { resolveAdapterConceptOwner } from "../../../src/indexer/lookup/adapter-concept-owner";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

type BundleKind = "ordinary" | "standalone";

interface CollisionFixture {
  kind: BundleKind;
  root: string;
  ownedDir: string;
  canonicalRef: string;
  aliases: string[];
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  _resetWarnOnceForTests();
});

afterEach(() => storage.cleanup());

function configure(kind: BundleKind): CollisionFixture {
  const root = kind === "ordinary" ? storage.stashDir : path.join(storage.root, "standalone-workflows");
  const ownedDir = kind === "ordinary" ? path.join(root, "workflows") : root;
  fs.mkdirSync(ownedDir, { recursive: true });
  const bundle = `${kind}-bundle`;
  const conceptId = kind === "ordinary" ? "workflows/collision" : "collision";
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: bundle,
    bundles: {
      [bundle]: {
        path: root,
        components: {
          main: {
            root: ".",
            adapter: kind === "ordinary" ? "akm" : "akm-workflow",
            writable: true,
          },
        },
      },
    },
  });
  resetConfigCache();
  return {
    kind,
    root,
    ownedDir,
    canonicalRef: `${bundle}//${conceptId}`,
    aliases: [`${bundle}//${conceptId}`, `${bundle}//${conceptId}.md`, `${bundle}//${conceptId}.MD`],
  };
}

function markdownWorkflow(label = "markdown"): string {
  return `---
type: workflow
description: ${label}
steps:
  - id: execute
    unit:
      exec:
        command: ["sh", "-c", "printf ${label}"]
---

## execute

Execute ${label}.
`;
}

/** A GitHub-shaped file is no longer a workflow source; it must be ignored, not collide. */
function yamlWorkflow(label = "yaml"): string {
  return `name: ${label}\non: { workflow_dispatch: null }\njobs: {}\n`;
}

function indexSnapshot(): number {
  if (!fs.existsSync(getDbPath())) return 0;
  const db = openIndexDatabase();
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count;
  } finally {
    closeDatabase(db);
  }
}

const kinds: BundleKind[] = ["ordinary", "standalone"];
const soleSourceCases = [
  [".md", markdownWorkflow],
  [".MD", markdownWorkflow],
] as const;

describe("workflow source canonical-ref collisions", () => {
  test.each(
    kinds.flatMap((kind) => soleSourceCases.map(([extension, source]) => [kind, extension, source] as const)),
  )("%s canonicalizes every explicit alias onto one %s workflow owner", async (kind, extension, source) => {
    const fixture = configure(kind);
    const sourcePath = path.join(fixture.ownedDir, `collision${extension}`);
    fs.writeFileSync(sourcePath, source(`sole-${kind}-${extension.slice(1).toLowerCase()}`));
    const adapterId = kind === "ordinary" ? "akm" : "akm-workflow";
    const canonicalConceptId = kind === "ordinary" ? "workflows/collision" : "collision";

    for (const ref of fixture.aliases) {
      const owner = resolveAdapterConceptOwner(fixture.root, adapterId, parseBundleRef(ref).conceptId);
      expect(owner, ref).toMatchObject({
        path: sourcePath,
        conceptId: canonicalConceptId,
        workflowSource: { path: sourcePath, canonicalName: "collision" },
      });
      await expect(loadWorkflowAsset(ref), ref).resolves.toMatchObject({
        ref: fixture.canonicalRef,
        path: sourcePath,
      });
    }
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test.each(kinds)("%s accepts a repeated-suffix filename, loading it under its real extension", async (kind) => {
    const fixture = configure(kind);
    const sourcePath = path.join(fixture.ownedDir, "collision.md.md");
    fs.writeFileSync(sourcePath, markdownWorkflow("nested-suffix"));

    await expect(loadWorkflowAsset(`${fixture.canonicalRef}.md.md`)).resolves.toMatchObject({
      path: sourcePath,
    });
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test("ordinary load rejects a canonical workflow source colliding with a loose smart-Markdown peer", async () => {
    const fixture = configure("ordinary");
    const canonicalPath = path.join(fixture.ownedDir, "collision.md");
    const loosePath = path.join(fixture.root, "collision.md");
    fs.writeFileSync(canonicalPath, markdownWorkflow("canonical"));
    fs.writeFileSync(loosePath, markdownWorkflow("loose"));

    await expect(loadWorkflowAsset(`${fixture.canonicalRef}.MD`)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
      message: expect.stringMatching(/multiple physical owners.*collision\.md.*workflows\/collision\.md/is),
    });
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test("a .yml sibling is not a workflow source: the .md loads and runs, with no collision", async () => {
    const fixture = configure("ordinary");
    fs.writeFileSync(path.join(fixture.ownedDir, "collision.md"), markdownWorkflow());
    fs.writeFileSync(path.join(fixture.ownedDir, "collision.yml"), yamlWorkflow());
    const mdPath = path.join(fixture.ownedDir, "collision.md");

    await expect(loadWorkflowAsset(fixture.canonicalRef)).resolves.toMatchObject({ path: mdPath });
    const started = await startWorkflowRun(fixture.canonicalRef);
    expect(started.run.status).toBe("active");
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "unexpected" }),
    });
    expect(result.done).toBe(true);
    // The sibling is skipped with a message saying why; the .md is still indexed.
    const indexed = await akmIndex({ stashDir: fixture.root, full: true });
    expect(indexed.warnings).toHaveLength(1);
    expect(indexed.warnings?.[0]).toMatch(/collision\.yml.*must use \.md/is);
    expect(indexSnapshot()).toBe(1);
  });

  test("ordinary fails on a malformed .md's own parse error, never a collision", async () => {
    const fixture = configure("ordinary");
    fs.writeFileSync(path.join(fixture.ownedDir, "collision.md"), "---\ntype: [unterminated\n---\n");

    await expect(loadWorkflowAsset(fixture.canonicalRef)).rejects.toMatchObject({
      code: "WORKFLOW_SOURCE_INVALID",
      message: expect.stringMatching(/collision\.md/is),
    });
    await expect(startWorkflowRun(fixture.canonicalRef)).rejects.toMatchObject({
      code: "WORKFLOW_SOURCE_INVALID",
    });
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
    expect(fs.existsSync(getDbPath())).toBe(false);

    const indexed = await akmIndex({ stashDir: fixture.root, full: true });
    expect(indexed.warnings).toHaveLength(1);
    expect(indexed.warnings?.[0]).toMatch(/collision\.md/i);
    expect(indexed.warnings?.[0]).not.toMatch(/multiple workflow source files/i);
    expect(indexSnapshot()).toBe(0);
  });

  test.each(kinds)("%s skips a candidate with a dangling symlink and uses the valid sibling instead", async (kind) => {
    const fixture = configure(kind);
    fs.symlinkSync(path.join(fixture.ownedDir, "does-not-exist"), path.join(fixture.ownedDir, "collision.md"));
    const siblingPath = path.join(fixture.ownedDir, "collision.MD");
    fs.writeFileSync(siblingPath, markdownWorkflow("valid"));

    await expect(loadWorkflowAsset(fixture.canonicalRef)).resolves.toMatchObject({ path: siblingPath });
  });

  test("preserves an authored symlink path and rejects a symlink that changes the source extension", async () => {
    const fixture = configure("ordinary");
    const markdownTarget = path.join(fixture.ownedDir, "target.md");
    const yamlTarget = path.join(fixture.ownedDir, "target.yml");
    const authoredPath = path.join(fixture.ownedDir, "collision.md");
    fs.writeFileSync(markdownTarget, markdownWorkflow("linked-markdown"));
    fs.writeFileSync(yamlTarget, yamlWorkflow("linked-yaml"));
    fs.symlinkSync(path.basename(markdownTarget), authoredPath);

    await expect(loadWorkflowAsset(fixture.canonicalRef)).resolves.toMatchObject({
      path: authoredPath,
    });

    fs.unlinkSync(authoredPath);
    fs.symlinkSync(path.basename(yamlTarget), authoredPath);
    const warnings: string[] = [];
    await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level === "warn") warnings.push(args.map(String).join(" "));
      },
      async () => {
        await expect(loadWorkflowAsset(fixture.canonicalRef)).rejects.toBeInstanceOf(Error);
      },
    );
    expect(warnings.some((w) => /collision\.md.*target\.yml.*different extension/is.test(w))).toBe(true);
    expect(fs.existsSync(getDbPath())).toBe(false);
    expect(indexSnapshot()).toBe(0);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
  });

  test("a lower-priority bundle collision cannot poison an unqualified ref already owned by the primary bundle", async () => {
    const secondaryRoot = path.join(storage.root, "secondary");
    const secondaryWorkflows = path.join(secondaryRoot, "workflows");
    fs.mkdirSync(secondaryWorkflows, { recursive: true });
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(storage.stashDir, "workflows", "collision.md"), markdownWorkflow("primary"));
    fs.writeFileSync(path.join(secondaryWorkflows, "collision.md"), markdownWorkflow("secondary-markdown"));
    fs.writeFileSync(path.join(secondaryWorkflows, "collision.MD"), markdownWorkflow("secondary-upper"));
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "primary",
      bundles: {
        primary: {
          path: storage.stashDir,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        secondary: {
          path: secondaryRoot,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    resetConfigCache();

    const indexed = await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(indexed.warnings ?? []).toEqual([]);

    await expect(loadWorkflowAsset("workflows/collision")).resolves.toMatchObject({
      ref: "primary//workflows/collision",
      path: path.join(storage.stashDir, "workflows", "collision.md"),
      plan: { description: "primary" },
    });
    await expect(lookupBundleRef(parseBundleRef("workflows/collision"))).resolves.toMatchObject({
      itemRef: "primary//workflows/collision",
      filePath: path.join(storage.stashDir, "workflows", "collision.md"),
    });
    await expect(akmShowUnified({ ref: "workflows/collision", skipLogging: true })).resolves.toMatchObject({
      ref: "workflows/collision",
      path: path.join(storage.stashDir, "workflows", "collision.md"),
    });
  });
});
