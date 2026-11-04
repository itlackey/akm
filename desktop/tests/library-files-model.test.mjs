import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/library-files-model.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { directoryKey, ancestorPaths, parentPath, filesHref, parseFilesHref, treeNodes } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("file navigation round trips actual paths and canonical refs without deriving one from the other", () => {
  const ref = "team//concepts/recovery:step-two";
  const href = filesHref(
    { bundle: "team", path: "notes/Backups & recovery", file: "notes/Backups & recovery/guide #2.md", ref, open: true },
    "#/search?q=backup&bundle=team",
  );
  const query = parseFilesHref(href);
  assert.equal(query.get("ref"), ref);
  assert.equal(query.get("file"), "notes/Backups & recovery/guide #2.md");
  assert.equal(query.get("readingFrom"), "#/search?q=backup&bundle=team");
  assert.equal(query.get("open"), "1");
  const folder = parseFilesHref(filesHref({ bundle: "team", path: "notes", file: "notes/guide.md" }));
  assert.equal(folder.has("ref"), false);
  assert.equal(folder.has("open"), false);
  assert.equal(parseFilesHref("#/search?bundle=team"), null);
});

test("physical breadcrumbs use directory segments, not concept categories", () => {
  assert.deepEqual(ancestorPaths("references/operations/backups"), [
    "",
    "references",
    "references/operations",
    "references/operations/backups",
  ]);
  assert.equal(parentPath("references/operations/guide.md"), "references/operations");
  assert.equal(parentPath("README.md"), "");
});

test("tree only presents expanded immediate directory responses and keeps bundle identity distinct", () => {
  const root = directoryKey("team", ""),
    folder = directoryKey("team", "knowledge");
  const listings = new Map([
    [
      root,
      {
        bundle: "team",
        path: "",
        entries: [{ name: "knowledge", path: "knowledge", kind: "directory", assets: [] }],
        indexAvailable: true,
      },
    ],
    [
      folder,
      {
        bundle: "team",
        path: "knowledge",
        entries: [
          { name: "notes.txt", path: "knowledge/notes.txt", kind: "file", assets: [] },
          {
            name: "source.md",
            path: "knowledge/source.md",
            kind: "file",
            assets: [
              { ref: "team//a", type: "knowledge" },
              { ref: "team//b", type: "knowledge" },
            ],
          },
        ],
        indexAvailable: true,
      },
    ],
  ]);
  assert.deepEqual(
    treeNodes(["team", "other"], listings, new Set()).map((node) => node.name),
    ["team", "other"],
  );
  assert.deepEqual(
    treeNodes(["team", "other"], listings, new Set([root])).map((node) => node.name),
    ["team", "knowledge", "other"],
  );
  const visible = treeNodes(["team", "other"], listings, new Set([root, folder]));
  assert.deepEqual(
    visible.map((node) => node.level),
    [1, 2, 3, 3, 1],
  );
  assert.deepEqual(
    visible[3].assets.map((asset) => asset.ref),
    ["team//a", "team//b"],
  );
  assert.equal(visible[2].assets.length, 0, "unindexed text remains visible without an invented identity");
  assert.notEqual(directoryKey("team", "knowledge"), directoryKey("other", "knowledge"));
  assert.equal(visible[3].position, 2);
  assert.equal(visible[3].size, 2);
  assert.equal(visible[3].parentKey, folder);
});
