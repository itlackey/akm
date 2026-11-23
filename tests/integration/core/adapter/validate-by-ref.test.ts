import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../../../src/core/adapter/adapters/akm-adapter";
import type { Bundle } from "../../../../src/core/adapter/types";
import { validateBundleAssets } from "../../../../src/core/assets/validate";
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

  test("it does not resolve spellings on the live tree: no realpath, lstat or process", async () => {
    write("knowledge/guide.md");
    const refuse = (what: string) => () => {
      throw new Error(`${what} is a read of the live tree`);
    };
    const spies = [
      spyOn(fs, "realpathSync").mockImplementation(refuse("realpath") as never),
      spyOn(fs, "lstatSync").mockImplementation(refuse("lstat") as never),
      spyOn(childProcess, "spawnSync").mockImplementation(refuse("a process") as never),
    ];
    try {
      const found = await akmAdapter.validate(
        b,
        [{ conceptId: "knowledge/guide", op: "update", content: NO_UPDATED }],
        {},
      );
      expect(found.map((d) => d.issue)).toContain("missing-updated");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
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
