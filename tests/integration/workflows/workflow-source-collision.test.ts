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
    aliases: [
      `${bundle}//${conceptId}`,
      `${bundle}//${conceptId}.md`,
      `${bundle}//${conceptId}.yml`,
      `${bundle}//${conceptId}.MD`,
      `${bundle}//${conceptId}.YML`,
    ],
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

function yamlWorkflow(label = "yaml"): string {
  return `name: ${label}
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: execute
        run: printf ${label}
        shell: sh
`;
}

function writeCollision(fixture: CollisionFixture, extensions: [string, string] = [".md", ".yml"]): void {
  fs.writeFileSync(path.join(fixture.ownedDir, `collision${extensions[0]}`), markdownWorkflow());
  fs.writeFileSync(path.join(fixture.ownedDir, `collision${extensions[1]}`), yamlWorkflow());
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
  [".yml", yamlWorkflow],
  [".MD", markdownWorkflow],
  [".YML", yamlWorkflow],
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
    const sourcePath = path.join(fixture.ownedDir, "collision.md.yml");
    fs.writeFileSync(sourcePath, yamlWorkflow("nested-suffix"));

    await expect(loadWorkflowAsset(`${fixture.canonicalRef}.md.yml`)).resolves.toMatchObject({
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

  test("ordinary picks the .md source deterministically over a colliding .yml sibling and loads/runs normally", async () => {
    const fixture = configure("ordinary");
    writeCollision(fixture);
    const mdPath = path.join(fixture.ownedDir, "collision.md");

    for (const ref of fixture.aliases) {
      await expect(loadWorkflowAsset(ref), ref).resolves.toMatchObject({ path: mdPath });
    }

    const started = await startWorkflowRun(fixture.canonicalRef);
    expect(started.run.status).toBe("active");
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "unexpected" }),
    });
    expect(result.done).toBe(true);
    expect((await listWorkflowRuns()).runs).toHaveLength(1);
  });

  test("standalone still rejects a .md/.yml collision via a separate, unfixed adapter-ownership guard", async () => {
    const fixture = configure("standalone");
    writeCollision(fixture);

    for (const ref of fixture.aliases) {
      await expect(loadWorkflowAsset(ref), ref).rejects.toMatchObject({ code: "RESOURCE_ALREADY_EXISTS" });
    }
  });

  test("ordinary treats extension-case variants as the same canonical ref and still picks .MD deterministically", async () => {
    const fixture = configure("ordinary");
    writeCollision(fixture, [".MD", ".YmL"]);
    const mdPath = path.join(fixture.ownedDir, "collision.MD");

    await expect(loadWorkflowAsset(fixture.canonicalRef)).resolves.toMatchObject({ path: mdPath });
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test("standalone treats extension-case variants as the same canonical ref, still refused by the separate adapter-ownership guard", async () => {
    const fixture = configure("standalone");
    writeCollision(fixture, [".MD", ".YmL"]);

    await expect(loadWorkflowAsset(fixture.canonicalRef)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
      message: expect.stringMatching(/collision\.MD.*collision\.YmL/is),
    });
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test("ordinary picks the malformed .md deterministically and fails on its own parse error, never a collision", async () => {
    const fixture = configure("ordinary");
    fs.writeFileSync(path.join(fixture.ownedDir, "collision.md"), "---\ntype: [unterminated\n---\n");
    fs.writeFileSync(path.join(fixture.ownedDir, "collision.yml"), yamlWorkflow("valid"));

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
    expect(indexSnapshot()).toBe(1);
  });

  test.each(kinds)("%s skips a candidate with a dangling symlink and uses the valid sibling instead", async (kind) => {
    const fixture = configure(kind);
    fs.symlinkSync(path.join(fixture.ownedDir, "does-not-exist"), path.join(fixture.ownedDir, "collision.md"));
    const yamlPath = path.join(fixture.ownedDir, "collision.yml");
    fs.writeFileSync(yamlPath, yamlWorkflow("valid"));

    await expect(loadWorkflowAsset(fixture.canonicalRef)).resolves.toMatchObject({ path: yamlPath });
  });

  test("preserves an authored symlink path and rejects a symlink that changes source format", async () => {
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
    expect(warnings.some((w) => /collision\.md.*target\.yml.*different source format/is.test(w))).toBe(true);
    expect(fs.existsSync(getDbPath())).toBe(false);
    expect(indexSnapshot()).toBe(0);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
  });

  test("ordinary indexes, looks up, and shows the .md winner without any collision warning", async () => {
    const fixture = configure("ordinary");
    writeCollision(fixture);
    const mdPath = path.join(fixture.ownedDir, "collision.md");

    // Repeat the full scan: filesystem enumeration is not a precedence rule.
    // Every pass must persist only the `.md` source for this canonical ref.
    for (let run = 0; run < 3; run++) {
      const indexed = await akmIndex({ stashDir: fixture.root, full: true });
      expect(indexed.warnings ?? []).toEqual([]);
      expect(indexSnapshot()).toBe(1);
      await expect(lookupBundleRef(parseBundleRef(fixture.canonicalRef))).resolves.toMatchObject({
        filePath: mdPath,
      });
    }

    await expect(akmShowUnified({ ref: fixture.canonicalRef, skipLogging: true })).resolves.toMatchObject({
      path: mdPath,
    });
  });

  test("standalone: indexing silently picks a winner, but indexed lookup and show still reject via the separate adapter-ownership guard", async () => {
    const fixture = configure("standalone");
    writeCollision(fixture);

    const indexed = await akmIndex({ stashDir: fixture.root, full: true });
    expect(indexed.warnings ?? []).toEqual([]);
    expect(indexSnapshot()).toBe(1);

    await expect(lookupBundleRef(parseBundleRef(fixture.canonicalRef))).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    await expect(akmShowUnified({ ref: fixture.canonicalRef, skipLogging: true })).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
  });

  test("ordinary: a .yml sibling added after cache fill does not disturb the already-indexed .md, still loads and runs", async () => {
    const fixture = configure("ordinary");
    const markdownPath = path.join(fixture.ownedDir, "collision.md");
    fs.writeFileSync(markdownPath, markdownWorkflow("cached-markdown"));
    await akmIndex({ stashDir: fixture.root, full: true });
    const before = indexSnapshot();
    expect(before).toBe(1);

    fs.writeFileSync(path.join(fixture.ownedDir, "collision.yml"), yamlWorkflow("late-yaml"));

    await expect(loadWorkflowAsset(fixture.canonicalRef)).resolves.toMatchObject({ path: markdownPath });
    const started = await startWorkflowRun(fixture.canonicalRef);
    expect(started.run.status).toBe("active");
    expect(indexSnapshot()).toEqual(before);
  });

  test("standalone still refuses a collision added after cache fill via the separate adapter-ownership guard", async () => {
    const fixture = configure("standalone");
    const markdownPath = path.join(fixture.ownedDir, "collision.md");
    fs.writeFileSync(markdownPath, markdownWorkflow("cached-markdown"));
    await akmIndex({ stashDir: fixture.root, full: true });
    const before = indexSnapshot();
    expect(before).toBe(1);

    fs.writeFileSync(path.join(fixture.ownedDir, "collision.yml"), yamlWorkflow("late-yaml"));
    let dispatches = 0;

    await expect(loadWorkflowAsset(fixture.canonicalRef)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    await expect(startWorkflowRun(fixture.canonicalRef)).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
    await expect(
      runWorkflowSteps({
        target: fixture.canonicalRef,
        summaryJudge: null,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "unexpected" };
        },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_ALREADY_EXISTS" });

    expect(dispatches).toBe(0);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
    expect(indexSnapshot()).toEqual(before);
  });

  test("ordinary: a targeted reindex of a new .yml sibling stales the cache, and the read path falls back to the .md winner instead of serving the wrong file", async () => {
    const fixture = configure("ordinary");
    const markdownPath = path.join(fixture.ownedDir, "collision.md");
    const yamlPath = path.join(fixture.ownedDir, "collision.yml");
    fs.writeFileSync(markdownPath, markdownWorkflow("first"));
    await akmIndex({ stashDir: fixture.root, full: true });
    expect(indexSnapshot()).toBe(1);

    fs.writeFileSync(yamlPath, yamlWorkflow("second"));
    await indexWrittenAssets(fixture.root, [yamlPath], { bundleId: "ordinary-bundle" });
    expect(indexSnapshot()).toBe(1);

    expect(await lookupBundleRef(parseBundleRef(fixture.canonicalRef))).toBeNull();

    const dispatched: string[] = [];
    await runWorkflowSteps({
      target: fixture.canonicalRef,
      summaryJudge: null,
      dispatcher: async (request) => {
        dispatched.push(JSON.stringify(request));
        return { ok: true, text: "done" };
      },
    });
    expect(dispatched.join(" ")).toContain("printf first");
    expect(dispatched.join(" ")).not.toContain("printf second");

    await akmIndex({ stashDir: fixture.root, full: true });
    await expect(lookupBundleRef(parseBundleRef(fixture.canonicalRef))).resolves.toMatchObject({
      filePath: markdownPath,
    });
  });

  test("a lower-priority bundle collision cannot poison an unqualified ref already owned by the primary bundle", async () => {
    const secondaryRoot = path.join(storage.root, "secondary");
    const secondaryWorkflows = path.join(secondaryRoot, "workflows");
    fs.mkdirSync(secondaryWorkflows, { recursive: true });
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(storage.stashDir, "workflows", "collision.md"), markdownWorkflow("primary"));
    fs.writeFileSync(path.join(secondaryWorkflows, "collision.md"), markdownWorkflow("secondary-markdown"));
    fs.writeFileSync(path.join(secondaryWorkflows, "collision.yml"), yamlWorkflow("secondary-yaml"));
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
    await expect(loadWorkflowAsset("secondary//workflows/collision")).resolves.toMatchObject({
      ref: "secondary//workflows/collision",
      path: path.join(secondaryWorkflows, "collision.md"),
      plan: { description: "secondary-markdown" },
    });
  });
});
