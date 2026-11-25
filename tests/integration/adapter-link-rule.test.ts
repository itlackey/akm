/**
 * The one symbolic-link rule for every write (#1774): create, update, delete, retire and restore against a link
 * inside the bundle, one leaving it, a dangling one and a hard link. Real files and links, so integration target.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmAdapter } from "../../src/core/adapter/adapters/akm-adapter";
import type { Bundle } from "../../src/core/adapter/types";
import { sandboxStashDir } from "../_helpers/sandbox";

let sandbox: ReturnType<typeof sandboxStashDir>;
let bundle: Bundle & { root: string };

beforeEach(() => {
  sandbox = sandboxStashDir();
  bundle = { id: "stash", root: sandbox.dir };
});
afterEach(() => sandbox.cleanup());

describe("the link rule for every write", () => {
  const kn = (rel: string) => path.join(bundle.root, "knowledge", rel);
  const refusal = /Write path contains a symbolic link below source "stash"/;
  beforeEach(() => fs.writeFileSync(kn("target.md"), "OLD\n"));

  test("an update refuses a link that leaves the bundle or leads to nothing", () => {
    fs.symlinkSync(process.execPath, kn("out.md"));
    fs.symlinkSync("nowhere.md", kn("dangling.md"));
    for (const name of ["out", "dangling"]) {
      expect(() => akmAdapter.update(bundle, `knowledge/${name}`, "NEW\n")).toThrow(refusal);
      expect(fs.lstatSync(kn(`${name}.md`)).isSymbolicLink()).toBe(true);
    }
    expect(fs.readFileSync(kn("target.md"), "utf8")).toBe("OLD\n");
  });

  test("a create treats a hard link as a regular file", () => {
    fs.linkSync(kn("target.md"), kn("hard.md"));
    akmAdapter.create(bundle, { type: "knowledge", name: "hard", content: "NEW\n" }, { replace: true });
    expect(fs.readFileSync(kn("hard.md"), "utf8")).toContain("NEW\n");
    expect(fs.readFileSync(kn("target.md"), "utf8")).toBe("OLD\n");
  });

  test("delete removes a symbolic link itself, never its target, and a hard link as one name", () => {
    fs.symlinkSync("target.md", kn("in.md"));
    fs.symlinkSync(process.execPath, kn("out.md"));
    fs.symlinkSync("nowhere.md", kn("dangling.md"));
    fs.linkSync(kn("target.md"), kn("hard.md"));

    for (const name of ["in", "out", "dangling", "hard"]) {
      expect(akmAdapter.delete(bundle, `knowledge/${name}`)[0]?.conceptId).toBe(`knowledge/${name}`);
      expect(fs.lstatSync(kn(`${name}.md`), { throwIfNoEntry: false })).toBeUndefined();
    }
    expect(fs.readFileSync(kn("target.md"), "utf8")).toBe("OLD\n");
    expect(fs.existsSync(process.execPath)).toBe(true);
  });

  test("retire refuses every symbolic link, because archiving a relative link would leave it dangling", () => {
    fs.symlinkSync("target.md", kn("in.md"));
    fs.symlinkSync(process.execPath, kn("out.md"));
    fs.symlinkSync("nowhere.md", kn("dangling.md"));
    for (const name of ["in", "out", "dangling"]) {
      expect(() => akmAdapter.retire(bundle, `knowledge/${name}`, { reason: "duplicate" })).toThrow(refusal);
      expect(fs.lstatSync(kn(`${name}.md`)).isSymbolicLink()).toBe(true);
    }
    expect(fs.readFileSync(kn("target.md"), "utf8")).toBe("OLD\n");
  });

  test("retire and restore treat a hard link as a regular file", () => {
    fs.linkSync(kn("target.md"), kn("hard.md"));
    const [retired] = akmAdapter.retire(bundle, "knowledge/hard", { reason: "duplicate" });
    expect(fs.existsSync(kn("hard.md"))).toBe(false);
    expect(fs.readFileSync(kn("target.md"), "utf8")).toBe("OLD\n");

    akmAdapter.restore(bundle, retired?.handle as string);
    expect(fs.readFileSync(kn("hard.md"), "utf8")).toBe("OLD\n");
    expect(fs.readFileSync(kn("target.md"), "utf8")).toBe("OLD\n");
  });

  test("restore refuses a symbolic link at the original path and treats a hard link as an existing file", () => {
    for (const kind of ["in", "out", "dangling", "hard"] as const) {
      const conceptId = `knowledge/restore-${kind}`;
      const file = kn(`restore-${kind}.md`);
      akmAdapter.create(bundle, { type: "knowledge", name: `restore-${kind}`, content: "ARCHIVED\n" });
      const [retired] = akmAdapter.retire(bundle, conceptId, { reason: "duplicate" });
      if (kind === "in") fs.symlinkSync("target.md", file);
      if (kind === "out") fs.symlinkSync(process.execPath, file);
      if (kind === "dangling") fs.symlinkSync("nowhere.md", file);
      if (kind === "hard") fs.linkSync(kn("target.md"), file);

      expect(() => akmAdapter.restore(bundle, retired?.handle as string)).toThrow(
        kind === "hard" ? /already exists \(created since retirement\)/ : refusal,
      );
      expect(fs.readFileSync(kn("target.md"), "utf8")).toBe("OLD\n");
    }
  });

  test("delete through a parent folder link finds no asset below a folder link and removes nothing outside", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-outside-"));
    fs.writeFileSync(path.join(outside, "x.md"), "OUTSIDE\n");
    fs.symlinkSync(outside, kn("ext"));
    // The walk does not reach through the link, so the asset is not found; either way nothing outside goes.
    expect(() => akmAdapter.delete(bundle, "knowledge/ext/x")).toThrow();
    expect(fs.readFileSync(path.join(outside, "x.md"), "utf8")).toBe("OUTSIDE\n");

    // A folder link inside the bundle is not walked either: the asset is not found and nothing is removed.
    fs.mkdirSync(kn("real"));
    fs.writeFileSync(kn("real/y.md"), "Y\n");
    fs.symlinkSync("real", kn("alias"));
    expect(() => akmAdapter.delete(bundle, "knowledge/alias/y")).toThrow();
    expect(fs.existsSync(kn("real/y.md"))).toBe(true);
  });

  test("delete refuses a package reached through a folder link that leaves the bundle", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-outside-"));
    fs.mkdirSync(path.join(outside, "demo"));
    fs.writeFileSync(path.join(outside, "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
    fs.mkdirSync(path.join(bundle.root, "skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(bundle.root, "skills", "ext"));
    for (const id of ["skills/ext/demo", "skills/ext/demo/SKILL", "skill/ext/demo"]) {
      try {
        akmAdapter.delete(bundle, id);
      } catch {
        // refused or not found: either way nothing outside may go
      }
    }
    expect(fs.existsSync(path.join(outside, "demo", "SKILL.md"))).toBe(true);
  });
});
