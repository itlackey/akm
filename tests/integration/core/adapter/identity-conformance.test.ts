// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Identity is the path, for every adapter. The concept id of an asset is a pure function of its storage key, so
 * listing and finding an asset, placing one, naming a retired one and reporting a shadowed spelling read no file:
 * these tests run each of them with every file's bytes denied, and require what they return to agree with what the
 * index's `recognize` says.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  azureKeyVaultAdapter,
  genericFilesAdapter,
  okfAdapter,
  secretToolAdapter,
} from "../../../../src/core/adapter/adapters";
import { akmAdapter } from "../../../../src/core/adapter/adapters/akm-adapter";
import { walkStashFlat } from "../../../../src/core/adapter/directory/walker";
import { DirectoryAdapterBase } from "../../../../src/core/adapter/directory-adapter";
import { getAdapters } from "../../../../src/core/adapter/registry";
import type { Bundle } from "../../../../src/core/adapter/types";
import { identify, spellings } from "../../../_helpers/adapter-hooks";
import { withFakeSecretStores } from "../../../_helpers/fake-secret-stores";
import { sandboxStashDir } from "../../../_helpers/sandbox";

const BUNDLES = path.resolve(__dirname, "../../../fixtures/bundles");
const ROOT_BY_ID: Record<string, string> = {
  akm: path.resolve(__dirname, "../../../fixtures/stashes/all-types"),
  okf: path.join(BUNDLES, "okf-sample"),
  "llm-wiki": path.join(BUNDLES, "llm-wiki"),
  claude: path.join(BUNDLES, "claude"),
  opencode: path.join(BUNDLES, "opencode"),
  "agent-skills": path.join(BUNDLES, "agent-skills"),
  "akm-workflow": path.join(BUNDLES, "akm-workflow"),
  "akm-task": path.join(BUNDLES, "akm-task"),
  dotenv: path.join(BUNDLES, "dotenv"),
  "website-snapshot": path.join(BUNDLES, "website-snapshot"),
  "generic-files": path.join(BUNDLES, "generic-files"),
  "code-project": path.join(BUNDLES, "code-project"),
};

function directoryAdapters(): DirectoryAdapterBase[] {
  return getAdapters().filter((adapter): adapter is DirectoryAdapterBase => adapter instanceof DirectoryAdapterBase);
}

/** Every file under `root` but the ignore files the walk itself reads. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else if (entry.name !== ".gitignore") found.push(full);
  }
  return found;
}

let denied: ReturnType<typeof spyOn>[] = [];

/** Deny every read of the content of `files` until {@link allowReads}. */
function denyReads(files: readonly string[]): void {
  const protectedFiles = new Set(files.map((file) => path.resolve(file)));
  const original = fs.readFileSync;
  const originalOpen = fs.openSync;
  const refuse = (candidate: unknown): void => {
    if (typeof candidate === "string" && protectedFiles.has(path.resolve(candidate))) {
      throw new Error(`the content of ${candidate} must not be read`);
    }
  };
  denied.push(
    spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
      refuse(candidate);
      return original(candidate, options as never);
    }) as typeof fs.readFileSync),
    spyOn(fs, "openSync").mockImplementation(((candidate, ...rest) => {
      refuse(candidate);
      return (originalOpen as (...args: unknown[]) => number)(candidate, ...rest);
    }) as typeof fs.openSync),
  );
}

function allowReads(): void {
  for (const spy of denied) spy.mockRestore();
  denied = [];
}

afterEach(allowReads);

describe("identity is the path: every directory adapter, on its fixture", () => {
  test("with every file's bytes denied, list, read, place and retired succeed and agree", () => {
    for (const adapter of directoryAdapters()) {
      const root = ROOT_BY_ID[adapter.id] as string;
      const b: Bundle = { id: adapter.id, root };
      denyReads(filesUnder(root));
      try {
        const listing = adapter.list(b);
        expect(listing.assets.length, `${adapter.id} lists assets`).toBeGreaterThan(0);
        const concepts = listing.assets.map((asset) => asset.conceptId);
        expect(new Set(concepts).size, `${adapter.id}: one asset per concept`).toBe(concepts.length);
        for (const asset of listing.assets) {
          const found = adapter.read(b, asset.conceptId);
          expect(found?.conceptId, `${adapter.id}:${asset.conceptId}`).toBe(asset.conceptId);
          expect(found?.entry.file, `${adapter.id}:${asset.conceptId}`).toBe(asset.entry.file);
          expect(identify(adapter, asset.entry.key), `${adapter.id}:${asset.entry.key}`).toBe(asset.conceptId);
        }
        const [type] = adapter.writes;
        if (type !== undefined) {
          const placed = adapter.place(b, { type, name: "probe/new" });
          expect(placed, `${adapter.id} places ${type}`).toBeString();
          expect(adapter.read(b, placed), `${adapter.id}: a placed concept is not there yet`).toBeUndefined();
        }
        expect(adapter.retired(b), `${adapter.id} retired`).toEqual([]);
      } finally {
        allowReads();
      }
    }
  });

  test("the denial is real: describing a file for the index does read it", () => {
    const root = ROOT_BY_ID.akm as string;
    const b: Bundle = { id: "akm", root };
    const [asset] = akmAdapter.list(b).assets;
    denyReads(filesUnder(root));
    try {
      expect(() => akmAdapter.recognize(b, (asset as NonNullable<typeof asset>).entry)).toThrow(/must not be read/);
    } finally {
      allowReads();
    }
  });

  test("recognize names the concept identify names, for every walked file, and every spelling maps back", () => {
    for (const adapter of directoryAdapters()) {
      const root = ROOT_BY_ID[adapter.id] as string;
      const b: Bundle = { id: adapter.id, root };
      for (const file of walkStashFlat(root, { includeAllDirectories: true })) {
        const conceptId = identify(adapter, file.relPath);
        const document = conceptId === null ? null : adapter.recognize(b, file);
        expect(document?.conceptId ?? null, `${adapter.id}:${file.relPath}`).toBe(conceptId);
        if (conceptId === null) continue;
        expect(document?.ref, `${adapter.id}:${file.relPath}`).toBe(`${adapter.id}//${conceptId}`);
        const spelled = spellings(adapter, conceptId).map((spelling) => spelling.toLowerCase());
        expect(spelled, `${adapter.id}:${conceptId} spells ${file.relPath}`).toContain(file.relPath.toLowerCase());
      }
    }
  });
});

describe("a concept spelled twice: the first spelling wins for list, read and the finding, with no read", () => {
  let sandbox: ReturnType<typeof sandboxStashDir>;
  beforeEach(() => {
    sandbox = sandboxStashDir();
  });
  afterEach(() => sandbox.cleanup());

  function write(rel: string, content = "x\n"): string {
    const file = path.join(sandbox.dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  /** What `validate` says for one asset's pending content: no file is read, so it reports spellings alone. */
  async function shadowFinding(adapter: DirectoryAdapterBase, b: Bundle, conceptId: string) {
    const diagnostics = await adapter.validate(b, [{ conceptId, op: "update", content: "x" }], {});
    return diagnostics.filter((diagnostic) => diagnostic.issue === "shadowed-spelling");
  }

  test.each([
    ["akm", akmAdapter, "tasks/same", ["tasks/same.md", "tasks/same.yml"], "tasks/same.yml"],
    ["generic-files", genericFilesAdapter, "docs/f", ["docs/f.txt", "docs/f.md", "docs/f.text"], "docs/f.md"],
    ["okf", okfAdapter, "notes/a", ["notes/a.MD", "notes/a.md"], "notes/a.md"],
  ] as const)("%s: %s", async (_id, adapter, conceptId, files, winner) => {
    const b: Bundle = { id: "b", root: sandbox.dir };
    const paths = files.map((rel) => write(rel));
    denyReads(paths);
    try {
      const listed = adapter.list(b).assets.filter((asset) => asset.conceptId === conceptId);
      expect(listed.map((asset) => asset.entry.key)).toEqual([winner]);
      expect(adapter.read(b, conceptId)?.entry.key).toBe(winner);
      const [finding, ...rest] = await shadowFinding(adapter, b, conceptId);
      expect(rest).toEqual([]);
      expect(finding?.file).toBe(winner);
      for (const ignored of files.filter((rel) => rel !== winner)) expect(finding?.detail).toContain(ignored);
    } finally {
      allowReads();
    }
  });
});

describe("a file name asks for its concept's winner", () => {
  let sandbox: ReturnType<typeof sandboxStashDir>;
  beforeEach(() => {
    sandbox = sandboxStashDir();
  });
  afterEach(() => sandbox.cleanup());

  test.each([
    ["tasks/dup.md", "tasks/dup", ["tasks/dup.md", "tasks/dup.yml"], "tasks/dup.yml"],
    ["env/default.env", "env/default", ["env/default.env", "env/.env"], "env/.env"],
  ] as const)("%s reads what %s reads", (fileName, conceptId, files, winner) => {
    const b: Bundle = { id: "b", root: sandbox.dir };
    for (const rel of files) {
      fs.mkdirSync(path.dirname(path.join(sandbox.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(sandbox.dir, rel), "x\n");
    }
    const byName = akmAdapter.read(b, fileName);
    expect(byName?.conceptId).toBe(conceptId);
    expect(byName?.entry.key).toBe(winner);
    expect(akmAdapter.read(b, conceptId)?.entry.key).toBe(winner);
  });
});

describe("identity is the path: a secret manager's entries", () => {
  test("list, read, place and retired succeed and agree with recognize", async () => {
    const keyring = [
      {
        path: "/org/freedesktop/secrets/collection/akm/1",
        label: "gh_token",
        attributes: { akm: "akm/gh_token" },
        secret: "v",
      },
    ];
    await withFakeSecretStores({ keyrings: { akm: keyring }, vaults: { vault: { token: "v" } } }, async () => {
      for (const [adapter, location] of [
        [secretToolAdapter, "akm"],
        [azureKeyVaultAdapter, "vault"],
      ] as const) {
        const b: Bundle = { id: "bundle", root: "/not/a/directory", location };
        const { assets } = adapter.list(b);
        expect(assets.length, adapter.id).toBe(1);
        const [asset] = assets as [(typeof assets)[number]];
        expect(asset.entry.key, adapter.id).toBe(asset.conceptId);
        expect(adapter.read(b, asset.conceptId)?.conceptId, adapter.id).toBe(asset.conceptId);
        expect(adapter.recognize(b, asset.entry)?.conceptId, adapter.id).toBe(asset.conceptId);
        expect(adapter.place(b, { type: "secret", name: "other" }), adapter.id).toBe("secrets/other");
        expect(adapter.retired(b), adapter.id).toEqual([]);
      }
    });
  });
});

describe("a validated create is checked at the file a create writes", () => {
  test.each(
    directoryAdapters().flatMap((adapter) => adapter.writes.map((type) => [adapter.id, type] as const)),
  )("%s %s: the first spelling of the placed concept is the placed file", (id, type) => {
    const adapter = directoryAdapters().find((candidate) => candidate.id === id) as DirectoryAdapterBase;
    const sandbox = sandboxStashDir();
    try {
      const b: Bundle = { id: "b", root: sandbox.dir };
      const asset = { type, name: "probe" };
      let conceptId: string;
      try {
        conceptId = adapter.place(b, asset);
      } catch {
        return; // a name the adapter refuses to place has no file to compare
      }
      const placed = adapter.placement(b, asset)?.file;
      expect(placed).toBeDefined();
      expect(
        path
          .relative(sandbox.dir, placed as string)
          .split(path.sep)
          .join("/"),
      ).toBe(spellings(adapter, conceptId)[0] ?? "");
    } finally {
      sandbox.cleanup();
    }
  });
});
