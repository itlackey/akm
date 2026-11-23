// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A file's frontmatter for a form: keys and values as akm's YAML reads them, the keys akm knows for the type with the
 * required ones, and changes applied to a text that leave every other byte as written.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { documents } from "../../src/workspace";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  const claude = path.join(storage.root, "claude");
  fs.mkdirSync(claude, { recursive: true });
  writeSandboxConfig({
    ...makeConfig(storage.stashDir),
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
      claude: { path: claude, writable: true, components: { main: { root: ".", adapter: "claude" } } },
    },
  });
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const read = (relative: string, content: string, bundle = "stash") =>
  documents.frontmatter({ bundle, path: relative, content });
const apply = (content: string, ...changes: Array<{ key: string; value?: unknown; remove?: true }>) =>
  documents.applyFrontmatter({ content, changes }).content;

const LESSON = [
  "---",
  "# how to restore",
  "description: 'Restore with care'",
  "tags:",
  "  - ops",
  "  - restore",
  "custom_key: [a,   b]",
  "when_to_use: Before a restore",
  "updated: 2026-11-01",
  "---",
  "",
  "# Careful",
  "",
  "Body: with colons.",
  "",
].join("\n");

describe("reading a file's frontmatter", () => {
  test("the entries come in file order with their values, and known keys are marked", async () => {
    const result = await read("lessons/careful.md", LESSON);

    expect(result.type).toBe("lesson");
    expect(result.present).toBe(true);
    expect(result.entries).toEqual([
      { key: "description", value: "Restore with care", known: true },
      { key: "tags", value: ["ops", "restore"], known: true },
      { key: "custom_key", value: ["a", "b"], known: false },
      { key: "when_to_use", value: "Before a restore", known: true },
      { key: "updated", value: "2026-11-01", known: true },
    ]);
  });

  test("the keys akm knows for the type say which are required, from the checks that own them", async () => {
    const required = async (relative: string, content = "Body.\n") =>
      (await read(relative, content)).keys.filter((key) => key.required).map((key) => key.key);

    expect(await required("lessons/x.md")).toEqual(["description", "updated", "when_to_use"]);
    expect(await required("facts/x.md")).toEqual(["updated", "category"]);
    expect(await required("commands/x.md")).toEqual(["updated", "name", "type"]);
    expect(await required("reports/x.md")).toEqual(["updated"]);
    expect((await read("facts/x.md", "Body.\n")).keys.find((key) => key.key === "category")?.values).toContain("team");
    expect((await read("lessons/x.md", "Body.\n")).keys.find((key) => key.key === "updated")).toMatchObject({
      stamped: true,
    });
  });

  test("text with no frontmatter has none, and a file that is no asset knows no keys", async () => {
    expect(await read("lessons/x.md", "Just a body.\n")).toMatchObject({ present: false, entries: [] });
    expect(await read("notes/todo.txt", "one\n")).toMatchObject({ type: null, keys: [] });
  });

  test("frontmatter that does not parse is reported with its line and read as no entries", async () => {
    const result = await read("lessons/x.md", "---\ndescription: ok\nwhen_to_use: [unclosed\n---\n\nBody.\n");

    expect(result.entries).toEqual([]);
    expect(result.error).toEqual({ reason: "AKM Markdown has malformed YAML frontmatter.", line: expect.any(Number) });
  });

  test("a bundle of another adapter is read the same, with no type and no keys", async () => {
    const result = await read("agents/x.md", "---\ndescription: ok\n---\nBody.\n", "claude");

    expect(result).toMatchObject({ type: null, keys: [], present: true, markdown: true });
    expect(result.entries.map((entry) => entry.key)).toEqual(["description"]);
  });

  test("it says where the body starts and whether the file is Markdown, with and without frontmatter", async () => {
    const text = "---\ndescription: ok\n---\n\nBody.\n";
    const lesson = await read("lessons/x.md", text);
    const plain = await read("lessons/x.md", "Body only.\n");
    const script = await read("scripts/x.sh", "#!/bin/sh\n");
    const crlf = await read("lessons/x.md", "---\r\ndescription: ok\r\n---\r\nBody.\r\n");

    expect(text.slice(lesson.bodyStart)).toBe("\nBody.\n");
    expect([plain.bodyStart, plain.present]).toEqual([0, false]);
    expect("---\r\ndescription: ok\r\n---\r\nBody.\r\n".slice(crlf.bodyStart)).toBe("Body.\r\n");
    expect([lesson.markdown, script.markdown]).toEqual([true, false]);
  });

  test("a change reports where the body starts afterwards", () => {
    const changed = documents.applyFrontmatter({
      content: "---\ndescription: ok\n---\nBody.\n",
      changes: [{ key: "tags", value: ["a"] }],
    });

    expect(changed.content.slice(changed.bodyStart)).toBe("Body.\n");
  });
});

describe("changing keys leaves everything else as written", () => {
  test("a changed key keeps its place, and the comment, quoting, spacing, body and other keys stay byte for byte", () => {
    const changed = apply(LESSON, { key: "when_to_use", value: "Before every restore" });

    expect(changed).toBe(LESSON.replace("when_to_use: Before a restore", "when_to_use: Before every restore"));
  });

  test("a list value replaces the whole block of the key, and a new key goes before the closing fence", () => {
    const changed = apply(
      LESSON,
      { key: "tags", value: ["ops", "backup", "restore"] },
      { key: "project", value: "dr" },
    );

    expect(changed).toBe(
      LESSON.replace("tags:\n  - ops\n  - restore\n", "tags:\n  - ops\n  - backup\n  - restore\n").replace(
        "updated: 2026-11-01\n---",
        "updated: 2026-11-01\nproject: dr\n---",
      ),
    );
  });

  test("a removed key goes with its list items, and removing a key that is not there changes nothing", () => {
    expect(apply(LESSON, { key: "tags", remove: true })).toBe(LESSON.replace("tags:\n  - ops\n  - restore\n", ""));
    expect(apply(LESSON, { key: "absent", remove: true })).toBe(LESSON);
  });

  test("setting a key to the value it has leaves the text as it is", () => {
    expect(apply(LESSON, { key: "custom_key", value: ["a", "b"] })).toBe(LESSON);
    expect(apply(LESSON, { key: "description", value: "Restore with care" })).toBe(LESSON);
  });

  test("CRLF text keeps its line endings", () => {
    const crlf = LESSON.replaceAll("\n", "\r\n");

    expect(apply(crlf, { key: "project", value: "dr" })).toBe(
      crlf.replace("updated: 2026-11-01\r\n---", "updated: 2026-11-01\r\nproject: dr\r\n---"),
    );
  });

  test("a text with no frontmatter gains a block for the keys set", () => {
    expect(apply("Body.\n", { key: "description", value: "A note" })).toBe("---\ndescription: A note\n---\nBody.\n");
    expect(apply("Body.\n", { key: "description", remove: true })).toBe("Body.\n");
  });

  test("what cannot be changed as written is refused, not approximated", () => {
    expect(() => apply("---\ndescription: [unclosed\n---\nBody.\n", { key: "tags", value: ["x"] })).toThrow(
      "malformed YAML",
    );
    expect(() => apply(LESSON, { key: "not a key", value: "x" })).toThrow("not a frontmatter key");
    expect(() => apply(LESSON, { key: "tags" })).toThrow("setting a value or removing it");
  });

  test("the changed text reads back as exactly the intended entries", async () => {
    const changed = apply(
      LESSON,
      { key: "tags", value: ["a"] },
      { key: "custom_key", remove: true },
      { key: "project", value: "dr" },
    );

    const result = await read("lessons/careful.md", changed);

    expect(result.entries.map((entry) => entry.key)).toEqual([
      "description",
      "tags",
      "when_to_use",
      "updated",
      "project",
    ]);
    expect(result.entries.find((entry) => entry.key === "tags")?.value).toEqual(["a"]);
  });
});
