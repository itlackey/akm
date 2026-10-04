// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `applyReflectPatch`: reflect changes only an asset's `description`,
 * `when_to_use` and title, and akm keeps the body byte for byte. Pure string
 * in, string out: no storage, engine or events.
 */

import { describe, expect, test } from "bun:test";
import { applyReflectPatch } from "../../../src/commands/improve/reflect";
import { splitFrontmatter } from "../../../src/commands/improve/reflect-noise";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";

const REF = "knowledge/patched";
const NEW_DESCRIPTION = "A description that says what this asset covers";

describe("applyReflectPatch — the body is kept byte for byte", () => {
  test.each([
    ["a canonical layout", "---\ndescription: Old description text\n---\n\n# Heading\n\nBody.\n"],
    ["no trailing newline", "---\ndescription: Old description text\n---\n\n# Heading\n\nBody."],
    ["no blank line after the fence", "---\ndescription: Old description text\n---\n# Heading\n\nBody.\n"],
    ["several blank lines after the fence", "---\ndescription: Old description text\n---\n\n\n\n# Heading\n\nBody.\n"],
    [
      "trailing spaces, CRLF and blank lines at the end",
      "---\ndescription: Old description text\n---\n\n# Heading  \r\nBody.\t\r\n\n\n\n",
    ],
    ["an indented code block first", "---\ndescription: Old description text\n---\n\n    indented code\n\nBody.\n"],
  ])("a description-only patch changes only the description: %s", (_name, source) => {
    const patched = applyReflectPatch({ description: NEW_DESCRIPTION }, source, REF);

    if (!patched) throw new Error("expected the patch to change the asset");
    expect(splitFrontmatter(patched.content).body).toBe(splitFrontmatter(source).body);
    expect(parseFrontmatter(patched.content).data).toEqual({ description: NEW_DESCRIPTION });
    expect(patched.frontmatter).toEqual({ description: NEW_DESCRIPTION });
  });

  test("every other frontmatter key keeps its value and its place; `when_to_use` is set only when patched", () => {
    const source = [
      "---",
      "name: release-policy",
      "description: Release policy for production deploys",
      "tags:",
      "  - release",
      "  - policy",
      "when_to_use: Whenever you cut a release branch",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");

    const patched = applyReflectPatch({ when_to_use: "When a release branch is cut for production" }, source, REF);

    if (!patched) throw new Error("expected the patch to change the asset");
    const { data } = parseFrontmatter(patched.content);
    expect(Object.keys(data)).toEqual(["name", "description", "tags", "when_to_use"]);
    expect(data).toEqual({
      name: "release-policy",
      description: "Release policy for production deploys",
      tags: ["release", "policy"],
      when_to_use: "When a release branch is cut for production",
    });
  });

  test("a source with no frontmatter gains a block with one blank line, and its body is untouched", () => {
    const source = "# Heading\n\nBody without any frontmatter.\n";

    const patched = applyReflectPatch({ description: NEW_DESCRIPTION }, source, REF);

    expect(patched?.content).toBe(`---\ndescription: ${NEW_DESCRIPTION}\n---\n\n${source}`);
  });
});

describe("applyReflectPatch — a patch that changes nothing creates nothing", () => {
  const source =
    "---\ndescription: Old description text\nwhen_to_use: When the old text is read\n---\n\n# Heading\n\nBody.\n";

  test.each([
    ["every field null", {}],
    ["a description equal to the source's", { description: "Old description text" }],
    [
      "both fields equal to the source's",
      { description: "Old description text", when_to_use: "When the old text is read" },
    ],
    ["a title for a body that already has a level-1 heading", { title: "A different title" }],
  ])("%s", (_name, patch) => {
    expect(applyReflectPatch(patch, source, REF)).toBeUndefined();
  });

  test("a source with no content has nothing to patch", () => {
    expect(applyReflectPatch({ description: NEW_DESCRIPTION }, "", REF)).toBeUndefined();
    expect(applyReflectPatch({ description: NEW_DESCRIPTION }, "\n  \n", REF)).toBeUndefined();
  });

  test("a source with no frontmatter and an empty patch stays as it is", () => {
    expect(applyReflectPatch({}, "# Heading\n\nBody.\n", REF)).toBeUndefined();
  });
});

describe("applyReflectPatch — a title is a level-1 heading, added only to a body that has none", () => {
  const frontmatter = "---\ndescription: Old description text\n---\n";

  test("it is prepended with one blank line after it", () => {
    const patched = applyReflectPatch({ title: "Release runbook" }, `${frontmatter}\nSome prose.\n`, REF);

    expect(patched?.content).toBe(`${frontmatter}\n# Release runbook\n\nSome prose.\n`);
  });

  test("a body with only lower-level headings has no level-1 heading", () => {
    const patched = applyReflectPatch({ title: "Release runbook" }, `${frontmatter}\n## Steps\n\nSome prose.\n`, REF);

    expect(patched?.content).toBe(`${frontmatter}\n# Release runbook\n\n## Steps\n\nSome prose.\n`);
  });

  test("a body that has one ignores the title, and the rest of the patch still applies", () => {
    const source = `${frontmatter}\n# Existing title\n\nSome prose.\n`;

    const patched = applyReflectPatch({ title: "Release runbook", description: NEW_DESCRIPTION }, source, REF);

    expect(patched?.content).toBe(`---\ndescription: ${NEW_DESCRIPTION}\n---\n\n# Existing title\n\nSome prose.\n`);
  });

  test("the title and a description patch apply together", () => {
    const patched = applyReflectPatch(
      { title: "Release runbook", description: NEW_DESCRIPTION },
      `${frontmatter}\nSome prose.\n`,
      REF,
    );

    expect(patched?.content).toBe(`---\ndescription: ${NEW_DESCRIPTION}\n---\n\n# Release runbook\n\nSome prose.\n`);
  });

  test("a source with no frontmatter gets the heading and no frontmatter block", () => {
    const patched = applyReflectPatch({ title: "Release runbook" }, "Some prose.\n", REF);

    expect(patched?.content).toBe("# Release runbook\n\nSome prose.\n");
    expect(patched?.frontmatter).toBeUndefined();
  });
});

describe("applyReflectPatch — a description a required type lacks is derived from the asset's own text (#636)", () => {
  test("a source with frontmatter but no description gets one, even from a patch of nulls", () => {
    const patched = applyReflectPatch({}, "---\ntitle: Release notes\n---\n\nBody.\n", REF);

    expect(patched?.frontmatter).toEqual({ title: "Release notes", description: "Reference notes on Release notes." });
  });

  test("a source with no frontmatter at all gets no block injected", () => {
    expect(applyReflectPatch({}, "# Release notes\n\nBody.\n", REF)).toBeUndefined();
  });

  test("a type that does not require a description is left alone", () => {
    expect(applyReflectPatch({}, "---\ntitle: Release notes\n---\n\nBody.\n", "scripts/release")).toBeUndefined();
  });
});
