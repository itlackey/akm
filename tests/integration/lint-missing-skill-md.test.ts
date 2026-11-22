// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `missing-skill-md` is reachable again (issue #774).
 *
 * Two halves of the same gap:
 *
 *   1. `agent-skills` `validate()` iterated CHANGES, and a change is always a
 *      FILE — so a package directory carrying resources but no `SKILL.md`
 *      contributed nothing the loop could see. The code's own comment deferred
 *      the case to `directorySkillDiagnostics`, a symbol that did not exist.
 *      The check is now a real directory pass over `ValidateContext.list`.
 * Both are driven through the real `akm lint` entry point, plus a direct
 * `validate()` call for the containment rules the CLI cannot express.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { agentSkillsAdapter } from "../../src/core/adapter/adapters/agent-skills-adapter";
import { skillDirectoryDiagnostics } from "../../src/core/adapter/adapters/akm-lint";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { createValidateContext } from "../../src/core/adapter/validate-context";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function skillManifest(name: string): string {
  return `---\nname: ${name}\ndescription: A conformant skill used as the clean control.\n---\n\nBody.\n`;
}

describe("agent-skills: a package directory with no SKILL.md is flagged (issue #774)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("akm lint reports missing-skill-md for the manifest-less package only", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "skills-pack");

    // A conformant package (also what makes the root detect as agent-skills),
    // with a bundled resource dir that must NOT be treated as its own package.
    write(root, "pdf-processing/SKILL.md", skillManifest("pdf-processing"));
    write(root, "pdf-processing/reference/FORMS.md", "# Forms\n");
    // The broken one: resources, no manifest.
    write(root, "half-built/reference/NOTES.md", "# Notes\n");
    // A root-level file is not a package directory.
    write(root, "README.md", "# Skills pack\n");

    expect(detectAdapterId(root)).toBe("agent-skills");

    const result = await akmLint({ dir: root });
    const missing = result.flagged.filter((issue) => issue.issue === "missing-skill-md");

    expect(missing.map((issue) => issue.file)).toEqual(["half-built"]);
    expect(missing[0]?.detail).toBe("no SKILL.md in half-built/");
    expect(missing[0]?.fixed).toBe(false);
  });

  test("a fully conformant pack stays clean — resource dirs are not candidate packages", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "clean-pack");

    write(root, "pdf-processing/SKILL.md", skillManifest("pdf-processing"));
    write(root, "pdf-processing/reference/FORMS.md", "# Forms\n");
    write(root, "pdf-processing/assets/template.txt", "template\n");
    write(root, "README.md", "# Skills pack\n");

    const result = await akmLint({ dir: root });

    expect(result.flagged.filter((issue) => issue.issue === "missing-skill-md")).toEqual([]);
  });

  test("a grouping directory whose children carry manifests is not a broken package", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "grouped-pack");

    // `<group>/<name>/SKILL.md` — `skillPackage` accepts the nested shape, so
    // the group dir itself must not be reported for having no manifest of its own.
    write(root, "team/pdf-processing/SKILL.md", skillManifest("pdf-processing"));

    const diagnostics = await agentSkillsAdapter.validate(
      { id: "grouped", adapter: "agent-skills", root, writable: true },
      [{ path: "team/pdf-processing/SKILL.md", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.filter((d) => d.issue === "missing-skill-md")).toEqual([]);
  });

  test("one valid grouped package does not hide a manifest-less sibling", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "mixed-grouped-pack");

    write(root, "team/pdf-processing/SKILL.md", skillManifest("pdf-processing"));
    write(root, "team/half-built/reference/NOTES.md", "# Notes\n");

    const diagnostics = await agentSkillsAdapter.validate(
      { id: "mixed-grouped", adapter: "agent-skills", root, writable: true },
      [{ path: "team/pdf-processing/SKILL.md", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.filter((d) => d.issue === "missing-skill-md")).toEqual([
      {
        file: "team/half-built",
        issue: "missing-skill-md",
        detail: "no SKILL.md in team/half-built/",
        fixed: false,
      },
    ]);
  });

  test("dot-directories (.git, .github) are never candidate packages", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "dotted-pack");

    write(root, "pdf-processing/SKILL.md", skillManifest("pdf-processing"));
    write(root, ".github/workflows/ci.yml", "name: ci\n");

    const diagnostics = await agentSkillsAdapter.validate(
      { id: "dotted", adapter: "agent-skills", root, writable: true },
      [{ path: "pdf-processing/SKILL.md", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.filter((d) => d.issue === "missing-skill-md")).toEqual([]);
  });

  test("akm lint: grouping directories are clean, a manifest-less skill still flagged", async () => {
    storage = withIsolatedAkmStorage();
    const root = storage.stashDir;

    write(root, "skills/personal/writer/SKILL.md", skillManifest("writer"));
    write(root, "skills/personal/writer/reference/NOTES.md", "# Notes\n");
    write(root, "skills/sec/audit/SKILL.md", skillManifest("audit"));
    write(root, "skills/solo/SKILL.md", skillManifest("solo"));
    write(root, "skills/sec/half-built/reference/NOTES.md", "# Notes\n");
    write(root, "skills/incomplete/notes.md", "# Notes\n");

    const result = await akmLint({ dir: root, config: makeConfig(root) });
    const missing = result.flagged.filter((issue) => issue.issue === "missing-skill-md");

    expect(missing.map((issue) => issue.file).sort()).toEqual(["skills/incomplete", "skills/sec/half-built"]);
  });

  test.each([
    ["covered change first", ["skills/personal/a/SKILL.md", "skills/personal/b/x.md"]],
    ["incomplete change first", ["skills/personal/b/x.md", "skills/personal/a/SKILL.md"]],
  ])("akm adapter validate: grouped skills are checked per child (%s)", async (_label, changed) => {
    storage = withIsolatedAkmStorage();
    const root = storage.stashDir;
    write(root, "skills/personal/a/SKILL.md", skillManifest("a"));
    write(root, "skills/personal/b/x.md", "# X\n");

    const seen = new Set<string>();
    const ctx = createValidateContext({ root });
    const diagnostics = (await Promise.all(changed.map((file) => skillDirectoryDiagnostics(file, seen, ctx)))).flat();

    expect(diagnostics.map((d) => d.file)).toEqual(["skills/personal/b"]);
  });

  test("akm adapter validate: a plain skill dir without SKILL.md is reported once", async () => {
    storage = withIsolatedAkmStorage();
    const root = storage.stashDir;
    write(root, "skills/incomplete/notes.md", "# Notes\n");
    write(root, "skills/incomplete/more.md", "# More\n");

    const seen = new Set<string>();
    const ctx = createValidateContext({ root });
    const first = await skillDirectoryDiagnostics("skills/incomplete/notes.md", seen, ctx);
    const second = await skillDirectoryDiagnostics("skills/incomplete/more.md", seen, ctx);

    expect(first.map((d) => d.file)).toEqual(["skills/incomplete"]);
    expect(second).toEqual([]);
  });
});
