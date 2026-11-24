import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../../../src/core/adapter/adapters/akm-adapter";
import { akmWorkflowAdapter } from "../../../../src/core/adapter/adapters/akm-workflow-adapter";
import { genericFilesAdapter } from "../../../../src/core/adapter/adapters/generic-files-adapter";
import { okfAdapter } from "../../../../src/core/adapter/adapters/okf-adapter";
import type { Bundle } from "../../../../src/core/adapter/types";
import { createFileValidateContext } from "../../../../src/core/adapter/validate-context";
import { validateBundleAssets } from "../../../../src/core/assets/validate";
import { checkChanges } from "../../../_helpers/adapter-hooks";
import { sandboxStashDir } from "../../../_helpers/sandbox";

const UPDATED = "---\nupdated: 2026-01-01\n---\nbody\n";
const NO_UPDATED = "---\ntitle: a\n---\nbody\n";

let sandbox: ReturnType<typeof sandboxStashDir>;
let b: Bundle;

function write(rel: string, content = "# a\n"): void {
  const file = path.join(sandbox.dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  sandbox = sandboxStashDir();
  b = { id: "b", root: sandbox.dir };
});
afterEach(() => sandbox.cleanup());

describe("validate checks asset edits by ref", () => {
  test("a finding names its asset by ref and its file", async () => {
    write("knowledge/guide.md", NO_UPDATED);
    const found = await akmAdapter.validate(b, [{ conceptId: "knowledge/guide", op: "update" }], {});
    expect(found).toContainEqual(
      expect.objectContaining({ ref: "b//knowledge/guide", file: "knowledge/guide.md", issue: "missing-updated" }),
    );
  });

  test("a pending edit's content is checked in place of the stored file", async () => {
    write("knowledge/guide.md", UPDATED);
    const found = await akmAdapter.validate(
      b,
      [{ conceptId: "knowledge/guide", op: "update", content: NO_UPDATED }],
      {},
    );
    expect(found.map((d) => d.issue)).toContain("missing-updated");
    expect(await akmAdapter.validate(b, [{ conceptId: "knowledge/guide", op: "update" }], {})).not.toContainEqual(
      expect.objectContaining({ issue: "missing-updated" }),
    );
  });

  test("a concept two files spell is a shadowed spelling, found without a walk", async () => {
    write("tasks/twin.yml", "name: twin\n");
    write("tasks/twin.md");
    const found = await akmAdapter.validate(b, [{ conceptId: "tasks/twin", op: "update" }], {});
    expect(found).toContainEqual(
      expect.objectContaining({ ref: "b//tasks/twin", file: "tasks/twin.yml", issue: "shadowed-spelling" }),
    );
  });

  test("a deleted winner leaves no shadow: the snapshot has one file for the concept", async () => {
    write("tasks/twin.yml", "name: twin\n");
    write("tasks/twin.md");
    const found = await akmAdapter.validate(b, [{ conceptId: "tasks/twin", op: "delete" }], {});
    expect(found.filter((d) => d.issue === "shadowed-spelling")).toEqual([]);
  });

  test("it reads no file's content to find the files that hold a concept", async () => {
    write("tasks/twin.yml", "name: twin\n");
    write("tasks/twin.md", "# twin\n");
    const protectedFiles = new Set(["tasks/twin.yml", "tasks/twin.md"].map((rel) => path.join(sandbox.dir, rel)));
    const original = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((candidate: unknown, options: unknown) => {
      if (typeof candidate === "string" && protectedFiles.has(path.resolve(candidate))) {
        throw new Error(`the content of ${candidate} must not be read`);
      }
      return (original as (...args: unknown[]) => unknown)(candidate, options);
    }) as typeof fs.readFileSync);
    try {
      // The pending content is checked; the stored files are only looked for.
      const found = await akmAdapter.validate(
        b,
        [{ conceptId: "tasks/twin", op: "update", content: "name: twin\n" }],
        {},
      );
      expect(found.filter((d) => d.issue === "shadowed-spelling")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the file checks and the shadow check see one overlay of the pending changes", () => {
  test("a pending create adds a second spelling: a shadow, and the new file is in the snapshot the checks read", async () => {
    write("tasks/twin.yml", "name: twin\n");
    const changes = [{ path: "tasks/twin.md", op: "create" as const, after: "# twin\n" }];
    const ctx = createFileValidateContext({ root: sandbox.dir, changes });
    expect(await ctx.readFile("tasks/twin.md")).toBe("# twin\n");
    const found = await checkChanges(akmAdapter, b, changes, ctx);
    expect(found).toContainEqual(expect.objectContaining({ file: "tasks/twin.yml", issue: "shadowed-spelling" }));
  });

  test("a pending create with no content adds no file to either: no second spelling", async () => {
    write("tasks/twin.yml", "name: twin\n");
    const changes = [{ path: "tasks/twin.md", op: "create" as const }];
    const ctx = createFileValidateContext({ root: sandbox.dir, changes });
    expect(await ctx.readFile("tasks/twin.md")).toBeNull();
    const found = await checkChanges(akmAdapter, b, changes, ctx);
    expect(found.filter((d) => d.issue === "shadowed-spelling")).toEqual([]);
  });
});

describe("only files hold a concept: a folder, a link to a folder or a broken link is no spelling", () => {
  test("generic-files: guide.md beside a guide/ folder keeps guide.md's own findings and no shadow", async () => {
    write("guide.md", "---\ntitle: g\n---\nbody\n");
    write("guide/inner.md");
    const found = await genericFilesAdapter.validate(b, [{ conceptId: "guide", op: "update" }], {});
    expect(found.filter((d) => d.issue === "shadowed-spelling")).toEqual([]);
    expect(found).toContainEqual(expect.objectContaining({ file: "guide.md", issue: "missing-updated" }));
  });

  test("generic-files: a link to a folder is no spelling either", async () => {
    write("guide.md", "---\ntitle: g\n---\nbody\n");
    write("realdir/x.md");
    fs.symlinkSync("realdir", path.join(sandbox.dir, "guide.markdown"));
    const found = await genericFilesAdapter.validate(b, [{ conceptId: "guide", op: "update" }], {});
    expect(found.filter((d) => d.issue === "shadowed-spelling")).toEqual([]);
    expect(found).toContainEqual(expect.objectContaining({ file: "guide.md", issue: "missing-updated" }));
  });

  test("okf: y.MD beside a broken y.md link is checked as y.MD", async () => {
    write("y.MD", "---\ntype: concept\n---\nsee [x](nope-thing.md)\n");
    fs.symlinkSync("nowhere.md", path.join(sandbox.dir, "y.md"));
    const found = await okfAdapter.validate(b, [{ conceptId: "y", op: "update" }], {});
    expect(found.filter((d) => d.issue === "shadowed-spelling")).toEqual([]);
    expect(found).toContainEqual(expect.objectContaining({ file: "y.MD", issue: "missing-ref" }));
  });

  test("akm-workflow: z.md beside a z.MD/ folder is checked as z.md", async () => {
    write("z.md", "# z\n");
    write("z.MD/in.md");
    const found = await akmWorkflowAdapter.validate(b, [{ conceptId: "z", op: "update" }], {});
    expect(found.filter((d) => d.issue === "shadowed-spelling")).toEqual([]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((d) => d.file === "z.md")).toBe(true);
  });
});

describe("the facade's validateBundleAssets", () => {
  test("it asks the bundle's adapter for every asset it lists", async () => {
    write("knowledge/guide.md", NO_UPDATED);
    const bundle = { name: "b", path: sandbox.dir, adapterId: "akm" };
    const edits = [{ conceptId: "knowledge/guide", op: "update" as const }];
    expect(await validateBundleAssets(bundle)).toEqual(await akmAdapter.validate(b, edits, {}));
  });

  test("keep narrows the assets checked", async () => {
    write("knowledge/guide.md", NO_UPDATED);
    const found = await validateBundleAssets({ name: "b", path: sandbox.dir, adapterId: "akm" }, { keep: () => false });
    expect(found).toEqual([]);
  });
});
