import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildWorkflowTemplate, createWorkflowAsset } from "../../../src/workflows/authoring/authoring";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ bundles: { stash: { path: storage.stashDir } }, defaultBundle: "stash" });
});

afterEach(() => storage.cleanup());

// `createWorkflowAsset({ force: true })` without `from` replaces the file
// with a fresh template (or an explicit `content` override) — the git/
// symlink preflight logic below runs regardless. The CLI used to require
// `--force --reset` together and refuse plain `--force` with no `--from`;
// that CLI-only requirement is gone (0.9.12) — `--force` alone now means
// "replace with a fresh template", and `--reset` is a deprecated alias with
// no independent effect. See workflow-cli.ts's `run()` for the create
// command.
describe("workflow force publication safety", () => {
  test("force atomically replaces an existing workflow", () => {
    const created = createWorkflowAsset({ name: "replace" });
    const before = fs.statSync(created.path).ino;
    createWorkflowAsset({ name: "replace", content: buildWorkflowTemplate("replacement"), force: true });

    expect(fs.statSync(created.path).ino).not.toBe(before);
    expect(fs.readFileSync(created.path, "utf8")).toContain("Replacement");
  });

  test("rejects an existing descendant symlink instead of replacing its target", () => {
    const workflows = path.join(storage.stashDir, "workflows");
    const outside = path.join(storage.root, "outside");
    fs.mkdirSync(workflows, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(workflows, "team"));

    expect(() => createWorkflowAsset({ name: "team/release", force: true })).toThrow(/symbolic link/i);
    expect(fs.existsSync(path.join(outside, "release.md"))).toBe(false);
  });

  test("continues to support a symlinked source root", () => {
    const real = path.join(storage.root, "real-stash");
    const linked = path.join(storage.root, "linked-stash");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, linked);
    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir }, linked: { path: linked } },
      defaultBundle: "stash",
      defaultWriteTarget: "linked",
    });

    const created = createWorkflowAsset({ name: "release" });
    // Unified format: no "# Workflow:" prefix — frontmatter carries the graph
    // (spec §2.2).
    expect(fs.readFileSync(path.join(real, "workflows", "release.md"), "utf8")).toContain("type: workflow");
    expect(created.path).toBe(path.join(linked, "workflows", "release.md"));
  });
});
