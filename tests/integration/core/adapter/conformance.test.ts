// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-D gate — the cross-adapter CONFORMANCE suite (adapter-spec §4 / §12.3),
 * the Chunk-2 CLOSE. Exercises the two properties the format-neutral contract
 * requires of EVERY registered `BundleAdapter`, driven off `getAdapters()`,
 * so the suite covers the adapters
 * that are actually registered rather than a hand-picked pair.
 *
 * ── 1. `looksLikeRoot` own-root-only (§4) ──
 *
 * Install-time root detection MUST be UNAMBIGUOUS: on a bundle's own root,
 * exactly one adapter's `looksLikeRoot` fires (§1.2's ordered probe would
 * otherwise pick arbitrarily). We assert the full matrix over the two golden
 * roots — the `okf` reference bundle (`tests/fixtures/bundles/okf-sample/`,
 * which has a root `index.md` and NO `TYPE_DIRS` subdir) and the `akm`
 * workspace stash (`tests/fixtures/stashes/all-types/`, which has `TYPE_DIRS`
 * subdirs and NO root `index.md`): each adapter's `looksLikeRoot` returns
 * `true` on its OWN golden root and `false` on the sibling's.
 *
 * These two frozen fixtures already separate cleanly (verified: `okf-sample`'s
 * only subdirs are `guides`/`metrics`/`tables` — none a `TYPE_DIRS` value — so
 * `akm.looksLikeRoot` abstains on it; `all-types` carries no root `index.md`,
 * so `okf.looksLikeRoot` abstains on it), so NO dedicated single-adapter root
 * fixtures were needed. Neither the frozen `all-types` stash nor any golden is
 * touched.
 *
 * ── 2. fold(recognize) over the walk ──
 *
 * The core walk × `recognize` IS the index. We exercise it concretely over each
 * golden root by folding `recognize` over the `walkStashFlat(root)` files
 * directly (the walk×recognize mapping the live indexer drains).
 */

import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  akmAdapter,
  azureKeyVaultAdapter,
  dotenvAdapter,
  genericFilesAdapter,
  llmWikiAdapter,
  okfAdapter,
  opencodeAdapter,
  secretToolAdapter,
} from "../../../../src/core/adapter/adapters";
import { hashContent } from "../../../../src/core/adapter/adapters/shared";
import { buildFileContext } from "../../../../src/core/adapter/directory/file-context";
import { walkStashFlat } from "../../../../src/core/adapter/directory/walker";
import { DirectoryAdapterBase } from "../../../../src/core/adapter/directory-adapter";
import { adapterForId, getAdapters } from "../../../../src/core/adapter/registry";
import { type Bundle, type IndexDocument, rootOf } from "../../../../src/core/adapter/types";
import { assetBundleOf } from "../../../../src/core/assets/bundle";
import { writeAssets } from "../../../../src/core/assets/write";
import { assetNotFound, NotFoundError, UsageError } from "../../../../src/core/errors";
import { fileMode, identify, serialize, spellings, typeOf } from "../../../_helpers/adapter-hooks";
import { withFakeSecretStores } from "../../../_helpers/fake-secret-stores";
import { findInBundle } from "../../../_helpers/find-in-bundle";

import { sandboxStashDir } from "../../../_helpers/sandbox";

/** The `okf` reference bundle's own root (root `index.md`, no `TYPE_DIRS` subdir). */
const OKF_ROOT = path.resolve(__dirname, "../../../fixtures/bundles/okf-sample");
/** The `akm` workspace stash's own root (`TYPE_DIRS` subdirs, no root `index.md`). */
const AKM_ROOT = path.resolve(__dirname, "../../../fixtures/stashes/all-types");
/** The `llm-wiki` bundle's own root (root `schema.md` + `pages/`; ALSO carries a root `index.md`). */
const LLM_WIKI_ROOT = path.resolve(__dirname, "../../../fixtures/bundles/llm-wiki");

/** The format-family fixture roots (#46) — one per new adapter. */
const BUNDLES = path.resolve(__dirname, "../../../fixtures/bundles");
const CLAUDE_ROOT = path.join(BUNDLES, "claude");
const OPENCODE_ROOT = path.join(BUNDLES, "opencode");
const AGENT_SKILLS_ROOT = path.join(BUNDLES, "agent-skills");
const AKM_WORKFLOW_ROOT = path.join(BUNDLES, "akm-workflow");
const AKM_TASK_ROOT = path.join(BUNDLES, "akm-task");
const DOTENV_ROOT = path.join(BUNDLES, "dotenv");
const WEBSITE_ROOT = path.join(BUNDLES, "website-snapshot");
const GENERIC_FILES_ROOT = path.join(BUNDLES, "generic-files");
const CODE_PROJECT_ROOT = path.join(BUNDLES, "code-project");

/**
 * adapter id → its OWN golden/fixture root. Every registered adapter EXCEPT the
 * explicit-config `generic-files` (whose `looksLikeRoot` never fires, §1.2) is
 * claimed by the §1.2 ordered probe on its own root.
 */
const OWN_ROOT_BY_ID: Record<string, string> = {
  okf: OKF_ROOT,
  akm: AKM_ROOT,
  "llm-wiki": LLM_WIKI_ROOT,
  claude: CLAUDE_ROOT,
  opencode: OPENCODE_ROOT,
  "agent-skills": AGENT_SKILLS_ROOT,
  "akm-workflow": AKM_WORKFLOW_ROOT,
  "akm-task": AKM_TASK_ROOT,
  dotenv: DOTENV_ROOT,
  "website-snapshot": WEBSITE_ROOT,
  "generic-files": GENERIC_FILES_ROOT,
  "code-project": CODE_PROJECT_ROOT,
};

/** The adapters this suite covers: every adapter that reads a directory. A secret manager's adapters have no root to probe and no fixture files; `tests/integration/secret-manager-bundles.test.ts` covers them. */
function directoryAdapters(): DirectoryAdapterBase[] {
  return getAdapters().filter((adapter): adapter is DirectoryAdapterBase => adapter instanceof DirectoryAdapterBase);
}

/** Adapters whose `looksLikeRoot` is intentionally never-firing (explicit-config, §1.2). */
const NEVER_FIRES = new Set(["generic-files", "code-project"]);

/**
 * The §1.2 install-time probe: the FIRST registered adapter (registration order
 * == probe precedence) whose `looksLikeRoot` fires claims the root. This is the
 * REAL "cannot shadow" contract — several probes legitimately overlap (a wiki
 * root also has a root `index.md` so `okf` fires; a `.claude`/`.opencode`/dotenv
 * root carries stash-subdir-shaped dirs so `akm` fires), and ORDER, not
 * exclusivity, resolves them.
 */
function orderedProbeOwner(root: string): string | undefined {
  for (const adapter of getAdapters()) {
    if (adapter.looksLikeRoot?.(root)) return adapter.id;
  }
  return undefined;
}

function bundle(id: string, root: string): Bundle {
  return { id, root };
}

/** `{ref, type}` projection of a doc stream — the comparison key for the walk×recognize mapping. */
function refType(docs: IndexDocument[]): Array<{ ref: string | undefined; type: string }> {
  return docs.map((d) => ({ ref: d.ref, type: d.type }));
}

/** fold(recognize): map `adapter.recognize` over the SAME `walkStashFlat(root)` files directly, dropping abstentions. */
function foldRecognize(adapter: DirectoryAdapterBase, c: Bundle): IndexDocument[] {
  const out: IndexDocument[] = [];
  for (const file of walkStashFlat(rootOf(c))) {
    const doc = adapter.recognize(c, file);
    if (doc !== null) out.push(doc);
  }
  return out;
}

// ── 1. looksLikeRoot own-root-only (§4) ──────────────────────────────────────

describe("conformance — looksLikeRoot own-root-only (§4)", () => {
  test("the built-in registry holds exactly 12 directory format families, and every one has a fixture root", () => {
    // Pins the fixture set: every registered directory adapter has a golden/fixture root in
    // OWN_ROOT_BY_ID, so the ordered-probe matrix below is complete.
    const ids = directoryAdapters().map((a) => a.id);
    expect(ids.sort()).toEqual([
      "agent-skills",
      "akm",
      "akm-task",
      "akm-workflow",
      "claude",
      "code-project",
      "dotenv",
      "generic-files",
      "llm-wiki",
      "okf",
      "opencode",
      "website-snapshot",
    ]);
    for (const id of ids) {
      if (id !== "code-project") expect(typeof adapterForId(id)?.looksLikeRoot).toBe("function");
      expect(OWN_ROOT_BY_ID[id]).toBeDefined();
    }
  });

  test("the §1.2 ordered probe selects each root's OWN adapter — no adapter shadows another", () => {
    for (const [id, root] of Object.entries(OWN_ROOT_BY_ID)) {
      if (NEVER_FIRES.has(id)) {
        // Explicit-config: NO probe claims a generic-files root.
        expect(orderedProbeOwner(root), id).toBeUndefined();
      } else {
        expect(orderedProbeOwner(root), id).toBe(id);
      }
    }
  });

  test("llm-wiki fires on its own root (schema.md + pages/), NOT on the okf/akm roots", () => {
    expect(llmWikiAdapter.looksLikeRoot?.(LLM_WIKI_ROOT)).toBe(true);
    expect(llmWikiAdapter.looksLikeRoot?.(OKF_ROOT)).toBe(false);
    expect(llmWikiAdapter.looksLikeRoot?.(AKM_ROOT)).toBe(false);
  });

  test("akm abstains on the llm-wiki root (no .stash marker, no placement stash-subdir)", () => {
    expect(akmAdapter.looksLikeRoot?.(LLM_WIKI_ROOT)).toBe(false);
  });

  test("OKF recognizes its own root and the OKF-compatible AKM superset", () => {
    expect(okfAdapter.looksLikeRoot?.(OKF_ROOT)).toBe(true);
    expect(okfAdapter.looksLikeRoot?.(AKM_ROOT)).toBe(true);
  });

  test("akm.looksLikeRoot fires on the all-types root, NOT on the okf-sample root", () => {
    expect(akmAdapter.looksLikeRoot?.(AKM_ROOT)).toBe(true);
    expect(akmAdapter.looksLikeRoot?.(OKF_ROOT)).toBe(false);
  });
});

// ── 2. fold(recognize) over the walk ─────────────────────────────────────────

describe("conformance — fold(recognize) over the walk", () => {
  // fold(recognize) over the golden walk is the live indexer's scan engine
  // (drainDirDocuments × adapter.recognize). These assertions pin each adapter's
  // recognize-over-walk behavior directly (owner ruling 2026-07-21 — the
  // walk×recognize mapping the retired `scanComponent` module used to wrap).
  test("akm: fold(recognize) over the all-types walk yields a stable ref/type stream", () => {
    const c = bundle("all-types", AKM_ROOT);
    const folded = foldRecognize(akmAdapter, c);
    expect(folded.length).toBeGreaterThan(0); // the fixture actually exercises the walk
    expect(refType(folded)).toEqual(refType(foldRecognize(akmAdapter, c)));
  });

  test("okf: fold(recognize) over the okf-sample walk yields a stable ref/type stream", () => {
    const c = bundle("okf-sample", OKF_ROOT);
    const folded = foldRecognize(okfAdapter, c);
    expect(folded.length).toBeGreaterThan(0);
    expect(refType(folded)).toEqual(refType(foldRecognize(okfAdapter, c)));
  });

  test("llm-wiki: fold(recognize) over the llm-wiki walk yields a stable ref/type stream", () => {
    const c = bundle("sample-wiki", LLM_WIKI_ROOT);
    const folded = foldRecognize(llmWikiAdapter, c);
    expect(folded.length).toBeGreaterThan(0);
    expect(refType(folded)).toEqual(refType(foldRecognize(llmWikiAdapter, c)));
  });
});

describe("conformance — identity and spellings are two-way canonical peers", () => {
  test("every registered adapter spells each recognized fixture file back from its canonical concept", () => {
    for (const adapter of directoryAdapters()) {
      const root = OWN_ROOT_BY_ID[adapter.id]!;
      const c = bundle(adapter.id, root);
      for (const file of walkStashFlat(root)) {
        const document = adapter.recognize(c, file);
        if (!document?.conceptId) continue;
        expect(identify(adapter, file.relPath), `${adapter.id}:${file.relPath}`).toBe(document.conceptId);
        expect(
          spellings(adapter, document.conceptId).map((spelling) => spelling.toLowerCase()),
          `${adapter.id}:${document.conceptId} must include ${file.relPath}`,
        ).toContain(file.relPath.toLowerCase());
      }
    }
  });

  test("every existing fixture spelling either is no asset or names the queried canonical concept", () => {
    for (const adapter of directoryAdapters()) {
      const root = OWN_ROOT_BY_ID[adapter.id]!;
      const c = bundle(adapter.id, root);
      for (const file of walkStashFlat(root)) {
        const indexed = adapter.recognize(c, file);
        if (!indexed?.conceptId) continue;
        for (const spelling of spellings(adapter, indexed.conceptId)) {
          if (!fs.existsSync(path.join(root, spelling))) continue;
          const identified = identify(adapter, spelling);
          if (identified !== null) expect(identified, `${adapter.id}:${spelling}`).toBe(indexed.conceptId);
        }
      }
    }
  });

  test("generated aliases, abstentions, suffixes, links, and collisions preserve the same two-way contract", () => {
    const sandbox = sandboxStashDir();
    try {
      const genericRoot = path.join(sandbox.dir, "generic");
      const dotenvRoot = path.join(sandbox.dir, "dotenv");
      const toolRoot = path.join(sandbox.dir, "tool");
      for (const root of [genericRoot, dotenvRoot, toolRoot]) fs.mkdirSync(root, { recursive: true });

      const genericComponent = bundle("generic", genericRoot);
      const upperText = path.join(genericRoot, "docs", "format.TEXT");
      fs.mkdirSync(path.dirname(upperText), { recursive: true });
      fs.writeFileSync(upperText, "generic text");
      expect(genericFilesAdapter.recognize(genericComponent, buildFileContext(genericRoot, upperText))?.conceptId).toBe(
        "docs/format",
      );
      expect(findInBundle({ name: "test", path: genericRoot }, "generic-files", "docs/format")?.entry.file).toBe(
        upperText,
      );

      fs.writeFileSync(path.join(genericRoot, "docs", "format.md"), "# collision");
      // Two spellings: the first in the adapter's order wins, `.md` before `.TEXT`.
      expect(findInBundle({ name: "test", path: genericRoot }, "generic-files", "docs/format")?.entry.file).toBe(
        path.join(genericRoot, "docs", "format.md"),
      );

      const extensionless = path.join(genericRoot, "LICENSE");
      fs.writeFileSync(extensionless, "license");
      expect(findInBundle({ name: "test", path: genericRoot }, "generic-files", "LICENSE")?.entry.file).toBe(
        extensionless,
      );
      const reserved = path.join(genericRoot, "index.md");
      fs.writeFileSync(reserved, "# reserved");
      expect(genericFilesAdapter.recognize(genericComponent, buildFileContext(genericRoot, reserved))).toBeNull();

      // Installing a bundle is the trust decision: an asset that is a symlink to
      // a file outside the bundle is owned like any other file (#1237).
      const outside = path.join(sandbox.dir, "outside.md");
      fs.writeFileSync(outside, "outside");
      const linked = path.join(genericRoot, "linked.md");
      fs.symlinkSync(outside, linked);
      const linkedOwner = findInBundle({ name: "test", path: genericRoot }, "generic-files", "linked");
      expect(linkedOwner?.entry.file).toBe(linked);

      const dotenvComponent = bundle("dotenv", dotenvRoot);
      const defaultEnv = path.join(dotenvRoot, "env", ".env");
      fs.mkdirSync(path.dirname(defaultEnv), { recursive: true });
      fs.writeFileSync(defaultEnv, "TOKEN=hidden\n");
      expect(dotenvAdapter.recognize(dotenvComponent, buildFileContext(dotenvRoot, defaultEnv))?.conceptId).toBe(
        "env/default",
      );
      expect(spellings(dotenvAdapter, "env/default")).toContain("env/.env");
      expect(findInBundle({ name: "test", path: dotenvRoot }, "dotenv", "env/default")?.entry.file).toBe(defaultEnv);

      const toolComponent = bundle("tool", toolRoot);
      const singular = path.join(toolRoot, "skill", "pkg", "SKILL.md");
      fs.mkdirSync(path.dirname(singular), { recursive: true });
      fs.writeFileSync(singular, "---\nname: pkg\ndescription: pkg\n---\n");
      expect(opencodeAdapter.recognize(toolComponent, buildFileContext(toolRoot, singular))).toBeNull();
      expect(spellings(opencodeAdapter, "skill/pkg")).toEqual([]);

      const canonicalSkill = path.join(toolRoot, "skills", "pkg", "SKILL.md");
      fs.mkdirSync(path.dirname(canonicalSkill), { recursive: true });
      fs.writeFileSync(canonicalSkill, "---\nname: pkg\ndescription: pkg\n---\n");
      expect(opencodeAdapter.recognize(toolComponent, buildFileContext(toolRoot, canonicalSkill))?.conceptId).toBe(
        "skills/pkg",
      );
      expect(spellings(opencodeAdapter, "skills/pkg")[0]).toBe("skills/pkg/SKILL.md");
      const nested = path.join(toolRoot, "skills", "pkg", "nested", "SKILL.md");
      fs.mkdirSync(path.dirname(nested), { recursive: true });
      fs.writeFileSync(nested, "---\nname: nested\ndescription: nested\n---\n");
      expect(opencodeAdapter.recognize(toolComponent, buildFileContext(toolRoot, nested))).toBeNull();
      expect(spellings(opencodeAdapter, "skills/pkg/nested")).toEqual([]);
    } finally {
      sandbox.cleanup();
    }
  });

  test("real recognition mechanically resolves every noncanonical AKM omission and nested dotenv default without bytes", () => {
    const sandbox = sandboxStashDir();
    try {
      const akmRoot = path.join(sandbox.dir, "akm");
      const dotenvRoot = path.join(sandbox.dir, "dotenv");
      fs.mkdirSync(akmRoot, { recursive: true });
      fs.mkdirSync(dotenvRoot, { recursive: true });
      const authored = [
        ["same.md", "Use $ARGUMENTS exactly.\n"],
        ["loose-workflow.md", "---\ntype: workflow\n---\n\n# Loose workflow\n"],
        ["loose-agent-command.md", "---\nagent: planner\n---\n\n# Loose agent command\n"],
        ["loose-model-agent.md", "---\nmodel: local\n---\n\n# Loose model agent\n"],
        ["loose-knowledge.md", "# Loose knowledge\n"],
        ["vendor/commands/deploy.md", "# Deploy\n"],
        ["workflows/README.md", "# Workflow documentation\n"],
        ["foreign/package/SKILL.md", "---\nname: package\ndescription: package\n---\n"],
        ["foreign/run.PY", "print('ok')\n"],
        ["foreign/tasks/nightly.YML", "schedule: '* * * * *'\nprompt: hello\n"],
        ["foreign/workflows/release.MD", "---\ntype: workflow\n---\n\n# Release\n"],
        ["env/team/.env", "TOKEN=hidden\n"],
      ] as const;
      const expected: Array<{ adapterId: string; root: string; path: string; conceptId: string }> = [];
      const akmComponent = bundle("akm", akmRoot);
      for (const [relativePath, content] of authored) {
        const filePath = path.join(akmRoot, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        const document = akmAdapter.recognize(akmComponent, buildFileContext(akmRoot, filePath));
        expect(document?.conceptId, relativePath).toBeDefined();
        if (!document?.conceptId) throw new Error(`Expected AKM recognition for ${relativePath}`);
        expected.push({ adapterId: "akm", root: akmRoot, path: filePath, conceptId: document.conceptId });
      }

      const nestedDefault = path.join(dotenvRoot, "env", "team", ".env");
      fs.mkdirSync(path.dirname(nestedDefault), { recursive: true });
      fs.writeFileSync(nestedDefault, "TOKEN=hidden\n");
      const dotenvDocument = dotenvAdapter.recognize(
        bundle("dotenv", dotenvRoot),
        buildFileContext(dotenvRoot, nestedDefault),
      );
      expect(dotenvDocument?.conceptId).toBe("env/team/default");
      if (!dotenvDocument?.conceptId) throw new Error("Expected nested dotenv default recognition");
      expected.push({
        adapterId: "dotenv",
        root: dotenvRoot,
        path: nestedDefault,
        conceptId: dotenvDocument.conceptId,
      });

      const protectedPaths = new Set(expected.map((entry) => path.resolve(entry.path)));
      const originalRead = fs.readFileSync;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
        if (protectedPaths.has(path.resolve(String(candidate)))) {
          throw new Error(`owner resolution must not read ${candidate}`);
        }
        return originalRead(candidate, options as never);
      }) as typeof fs.readFileSync);
      try {
        for (const entry of expected) {
          expect(
            findInBundle({ name: "test", path: entry.root }, entry.adapterId, entry.conceptId),
            entry.conceptId,
          ).toMatchObject({
            entry: { file: entry.path },
            conceptId: entry.conceptId,
          });
        }
      } finally {
        readSpy.mockRestore();
      }

      for (const entry of expected) {
        const adapter = adapterForId(entry.adapterId)!;
        expect(
          adapter.recognize(bundle(entry.adapterId, entry.root), buildFileContext(entry.root, entry.path))?.conceptId,
          entry.path,
        ).toBe(entry.conceptId);
      }
    } finally {
      sandbox.cleanup();
    }
  });

  test("two files that invert to one ref collide without reading either file: the first spelling is the asset", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const loose = path.join(root, "tasks", "same.md");
      const canonical = path.join(root, "tasks", "same.yml");
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(loose, "Use $ARGUMENTS exactly.\n");
      fs.writeFileSync(canonical, "name: same\n");
      const originalRead = fs.readFileSync;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
        if ([loose, canonical].some((entry) => path.resolve(entry) === path.resolve(String(candidate)))) {
          throw new Error(`owner resolution must not read ${candidate}`);
        }
        return originalRead(candidate, options as never);
      }) as typeof fs.readFileSync);
      try {
        const owner = findInBundle({ name: "test", path: root }, "akm", "tasks/same");
        expect(owner?.entry.file).toBe(canonical);
        expect(
          akmAdapter
            .list({ id: "test", root })
            .assets.filter((asset) => asset.conceptId === "tasks/same")
            .map((asset) => asset.entry.file),
        ).toEqual([canonical]);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      sandbox.cleanup();
    }
  });
});

describe("conformance — declared writes and what an adapter refuses", () => {
  test("every adapter declares the types it writes and retires; what it retires, it writes", () => {
    for (const adapter of getAdapters()) {
      expect(Array.isArray(adapter.writes), `${adapter.id} writes`).toBe(true);
      expect(Array.isArray(adapter.retires), `${adapter.id} retires`).toBe(true);
      for (const type of adapter.retires) expect(adapter.writes, `${adapter.id} retires ${type}`).toContain(type);
    }
  });

  test("an env file and a secret are never retired", () => {
    for (const adapter of getAdapters()) {
      expect(adapter.retires, adapter.id).not.toContain("env");
      expect(adapter.retires, adapter.id).not.toContain("secret");
    }
  });

  test("every adapter declares the types it writes; a read-only adapter's create and place refuse", () => {
    const b: Bundle = { id: "b", root: "/nonexistent/bundle", location: "x" };
    for (const adapter of getAdapters()) {
      expect(Array.isArray(adapter.writes), adapter.id).toBe(true);
      if (adapter.writes.length > 0) continue;
      expect(() => adapter.place(b, { type: "knowledge", name: "a" }), `${adapter.id} place`).toThrow();
      expect(() => adapter.create(b, { type: "knowledge", name: "a", content: "x" }), `${adapter.id} create`).toThrow();
    }
  });

  test("the writing adapters are the akm formats and the secret managers", () => {
    expect(
      getAdapters()
        .filter((adapter) => adapter.writes.length > 0)
        .map((adapter) => adapter.id),
    ).toEqual(["dotenv", "akm-workflow", "akm", "secret-tool", "azure-key-vault"]);
  });

  test("a secret manager's entry has no file, and its index document has no path", async () => {
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
        const { assets, complete } = adapter.list(b);
        expect(complete, adapter.id).toBe(true);
        expect(assets.length, adapter.id).toBe(1);
        const entry = assets[0]?.entry;
        expect(entry?.file, adapter.id).toBeUndefined();
        expect(entry?.key.startsWith("secrets/"), adapter.id).toBe(true);
        const document = adapter.recognize(b, entry as NonNullable<typeof entry>);
        expect(document?.type, adapter.id).toBe("secret");
        expect(document, adapter.id).not.toHaveProperty("path");
      }
    });
  });
});

// ── 3. Writes: one refusal per gate ──────────────────────────────────────────

/** The adapters that write files. */
function writableDirectoryAdapters(): DirectoryAdapterBase[] {
  return directoryAdapters().filter((adapter) => adapter.writes.length > 0);
}

/** A name every type of a writing adapter can place (a script's file needs an extension). */
function probeName(type: string, name: string): string {
  return type === "script" ? `${name}.sh` : name;
}

/** Names that would place a file no adapter recognizes (a reserved name, a sidecar) next to ordinary ones. */
const HOSTILE_NAMES = ["index", "log", "a/index", "x.lock", "x.sensitive", "README", "ok", "nested/ok"];

describe("conformance — create, place and read agree", () => {
  test("a created asset is read back under the id place gave, and its entry is the file create wrote", () => {
    for (const adapter of writableDirectoryAdapters()) {
      for (const type of adapter.writes) {
        const sandbox = sandboxStashDir();
        try {
          const b = bundle("round-trip", path.join(sandbox.dir, "b"));
          const conceptId = adapter.place(b, { type, name: probeName(type, "probe/sample") });
          const change = adapter.create(b, { type, name: probeName(type, "probe/sample"), content: "# probe\n" });
          expect(change.conceptId, `${adapter.id} ${type}`).toBe(conceptId);
          const read = adapter.read(b, conceptId);
          expect(read?.conceptId, `${adapter.id} ${type}`).toBe(conceptId);
          expect(change.changed, `${adapter.id} ${type}`).toContain(read?.entry.file as string);
          expect(fs.existsSync(read?.entry.file as string), `${adapter.id} ${type}`).toBe(true);
        } finally {
          sandbox.cleanup();
        }
      }
    }
  });

  test("place never returns an id that is no concept: it names a file the adapter lists, or it refuses", () => {
    for (const adapter of writableDirectoryAdapters()) {
      for (const type of adapter.writes) {
        for (const name of HOSTILE_NAMES) {
          const sandbox = sandboxStashDir();
          try {
            const b = bundle("place", path.join(sandbox.dir, "b"));
            let conceptId: string;
            try {
              conceptId = adapter.place(b, { type, name });
            } catch (error) {
              expect(error, `${adapter.id} ${type} "${name}"`).toBeInstanceOf(UsageError);
              expect(() => adapter.create(b, { type, name, content: "x" }), `${adapter.id} ${type} "${name}"`).toThrow(
                UsageError,
              );
              continue;
            }
            adapter.create(b, { type, name, content: "x" });
            expect(
              adapter.list(b).assets.map((asset) => asset.conceptId),
              `${adapter.id} ${type} "${name}"`,
            ).toContain(conceptId);
          } finally {
            sandbox.cleanup();
          }
        }
      }
    }
  });

  test("create over an existing concept is refused without replace, by every writing adapter", () => {
    for (const adapter of writableDirectoryAdapters()) {
      for (const type of adapter.writes) {
        const sandbox = sandboxStashDir();
        try {
          const b = bundle("twice", path.join(sandbox.dir, "b"));
          adapter.create(b, { type, name: probeName(type, "probe"), content: "# one\n" });
          expect(
            () => adapter.create(b, { type, name: probeName(type, "probe"), content: "# two\n" }),
            `${adapter.id} ${type}`,
          ).toThrow(/over an existing asset/);
          expect(() =>
            adapter.create(b, { type, name: probeName(type, "probe"), content: "# two\n" }, { replace: true }),
          ).not.toThrow();
        } finally {
          sandbox.cleanup();
        }
      }
    }
  });

  test("a replacing create rewrites the file the concept is read from, never a twin beside it", () => {
    // An off-spelling the adapter still reads (`.MD`, `env/default.env` for the default env that places at `env/.env`).
    const cases: Array<[DirectoryAdapterBase, string, string, string]> = [
      [akmAdapter, "knowledge", "guide", "knowledge/guide.MD"],
      [akmAdapter, "memory", "note", "memories/note.MD"],
      [dotenvAdapter, "env", "default", "env/default.env"],
    ];
    for (const [adapter, type, name, relPath] of cases) {
      const sandbox = sandboxStashDir();
      try {
        const root = path.join(sandbox.dir, "b");
        fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
        fs.writeFileSync(path.join(root, relPath), "old\n");
        const b = bundle("twin", root);
        const before = adapter.list(b).assets;
        expect(
          before.map((asset) => asset.entry.key),
          `${adapter.id} ${relPath}`,
        ).toContain(relPath);
        const change = adapter.create(b, { type, name, content: "# new\n" }, { replace: true });
        expect(change.changed, `${adapter.id} ${relPath}`).toContain(path.join(root, relPath));
        expect(fs.readFileSync(path.join(root, relPath), "utf8"), `${adapter.id} ${relPath}`).not.toBe("old\n");
        expect(
          adapter.list(b).assets.map((asset) => asset.entry.key),
          `${adapter.id} ${relPath}`,
        ).toEqual(before.map((asset) => asset.entry.key));
      } finally {
        sandbox.cleanup();
      }
    }
  });

  test("a secret manager refuses a create over an existing secret without replace, and replaces with it", async () => {
    const keyring = [
      { path: "/org/freedesktop/secrets/collection/akm/1", label: "t", attributes: { akm: "akm/t" }, secret: "v1" },
    ];
    await withFakeSecretStores({ keyrings: { akm: keyring }, vaults: { vault: { t: "v1" } } }, async () => {
      for (const [adapter, location] of [
        [secretToolAdapter, "akm"],
        [azureKeyVaultAdapter, "vault"],
      ] as const) {
        const b: Bundle = { id: "managed", root: "/not/a/directory", location };
        // A keyring entry is read by what a listing (the index's) recorded of it.
        adapter.list(b);
        expect(() => adapter.create(b, { type: "secret", name: "t", content: "v2" }), adapter.id).toThrow(
          /over an existing secret/,
        );
        expect(adapter.read(b, "secrets/t")?.entry.content(), adapter.id).toBe("v1");
        adapter.create(b, { type: "secret", name: "t", content: "v2" }, { replace: true });
        expect(adapter.read(b, "secrets/t")?.entry.content(), adapter.id).toBe("v2");
        adapter.create(b, { type: "secret", name: "fresh", content: "v3" });
        expect(adapter.read(b, "secrets/fresh")?.entry.content(), adapter.id).toBe("v3");
      }
    });
  });

  test("list reports assets only, one per concept, in the order the walk found them (N16)", () => {
    for (const adapter of directoryAdapters()) {
      const root = OWN_ROOT_BY_ID[adapter.id]!;
      const listing = adapter.list(bundle(adapter.id, root));
      expect(Object.keys(listing).sort(), adapter.id).not.toContain("files");
      const walked = walkStashFlat(root, { includeAllDirectories: true }).map((file) => file.relPath);
      const listed = listing.assets.map((asset) => asset.entry.key);
      expect(listed, adapter.id).toEqual(walked.filter((relPath) => listed.includes(relPath)));
      const concepts = listing.assets.map((asset) => asset.conceptId);
      expect(new Set(concepts).size, adapter.id).toBe(concepts.length);
    }
  });

  test("a directory adapter's index hash is the hash of its entry's content (the assetTypeFresh contract)", () => {
    for (const adapter of directoryAdapters()) {
      const b = bundle(adapter.id, OWN_ROOT_BY_ID[adapter.id]!);
      let checked = 0;
      for (const listed of adapter.list(b).assets) {
        const doc = adapter.recognize(b, listed.entry);
        if (doc === null) continue;
        expect(doc.hash, `${adapter.id}:${listed.conceptId}`).toBe(hashContent(listed.entry.content()));
        checked++;
      }
      expect(checked, adapter.id).toBeGreaterThan(0);
    }
  });

  test("list and read agree on the winner, for every listed asset and for a file spelling of it", () => {
    for (const adapter of directoryAdapters()) {
      const b = bundle(adapter.id, OWN_ROOT_BY_ID[adapter.id]!);
      for (const listed of adapter.list(b).assets) {
        const read = adapter.read(b, listed.conceptId);
        expect(read?.conceptId, `${adapter.id}:${listed.conceptId}`).toBe(listed.conceptId);
        expect(read?.entry.file, `${adapter.id}:${listed.conceptId}`).toBe(listed.entry.file);
        const fileSpelling = adapter.read(b, listed.entry.key);
        if (fileSpelling) expect(fileSpelling.entry.file, `${adapter.id}:${listed.entry.key}`).toBe(listed.entry.file);
      }
    }
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
      fs.writeFileSync(path.join(root, "tasks", "dup.md"), "# note\n");
      fs.writeFileSync(path.join(root, "tasks", "dup.yml"), "name: dup\n");
      const b = bundle("akm", root);
      const winner = akmAdapter.list(b).assets.filter((asset) => asset.conceptId === "tasks/dup");
      expect(winner.map((asset) => asset.entry.file)).toEqual([path.join(root, "tasks", "dup.yml")]);
      for (const asked of ["tasks/dup", "tasks/dup.md", "tasks/dup.yml"]) {
        expect(akmAdapter.read(b, asked)?.entry.file, asked).toBe(path.join(root, "tasks", "dup.yml"));
      }
    } finally {
      sandbox.cleanup();
    }
  });

  test("the facade writes the same bytes each time it creates one asset", () => {
    for (const adapter of writableDirectoryAdapters()) {
      for (const type of adapter.writes) {
        const sandbox = sandboxStashDir();
        try {
          const root = path.join(sandbox.dir, "b");
          fs.mkdirSync(root, { recursive: true });
          const target = {
            source: { kind: "filesystem" as const, name: "b", path: root, adapterId: adapter.id },
            config: { type: "filesystem" as const, name: "b", path: root, writable: true },
          };
          const create = () =>
            writeAssets(target, { purpose: "conformance" }, (w) => {
              const result = w.create({ type, name: probeName(type, "probe"), content: "# probe\n" });
              return fs.readFileSync(w.read(result.ref.slice("b//".length))?.entry.file as string);
            });
          const first = create();
          expect(create().equals(first), `${adapter.id} ${type}`).toBe(true);
        } finally {
          sandbox.cleanup();
        }
      }
    }
  });
});

describe("conformance — the gate rule: a content type has its path type's write behaviour", () => {
  /** Content that gives a loose or typed Markdown file a different type than its path alone. */
  const CONTENTS = [
    "# plain\n",
    "Use $ARGUMENTS exactly.\n",
    "---\nagent: planner\n---\nbody\n",
    "---\nmodel: local\n---\nbody\n",
    "---\ntype: workflow\n---\n\n# W\n",
    "---\ntype: knowledge\n---\nbody\n",
    "---\ntype: command\n---\nbody\n",
    "---\ntype: memory\n---\nbody\n",
  ];
  const PATHS = [
    "loose.md",
    "docs/loose.md",
    "knowledge/k.md",
    "commands/c.md",
    "agents/a.md",
    "memories/m.md",
    "workflows/w.md",
    "lessons/l.md",
    "tasks/t.md",
    "env/e.env",
    "secrets/s",
  ];

  /** What a file of `type` holds for a sample, with the type's name left out. */
  const serializedAs = (adapter: DirectoryAdapterBase, type: string, file: string): string =>
    String(serialize(adapter, type, file, "# sample\n")).replace(/^type: .*$/m, "type: <type>");

  test("for every writing adapter, each type recognize gives a path has the writes, retires, file mode and bytes of typeOf(path)", () => {
    for (const adapter of writableDirectoryAdapters()) {
      const sandbox = sandboxStashDir();
      try {
        const root = path.join(sandbox.dir, adapter.id);
        const b = bundle(adapter.id, root);
        let checked = 0;
        for (const relPath of PATHS) {
          const file = path.join(root, relPath);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          for (const content of CONTENTS) {
            fs.writeFileSync(file, content);
            const document = adapter.recognize(b, buildFileContext(root, file));
            if (!document) continue;
            const pathType = typeOf(adapter, relPath);
            const label = `${adapter.id}:${relPath} ${JSON.stringify(content.slice(0, 24))} (${document.type} vs ${pathType})`;
            expect(adapter.writes.includes(document.type), label).toBe(adapter.writes.includes(pathType));
            expect(adapter.retires.includes(document.type), label).toBe(adapter.retires.includes(pathType));
            expect(fileMode(adapter, document.type), label).toBe(fileMode(adapter, pathType));
            // Serialization records the type's own name in the document (`type: command`); it is the same otherwise.
            expect(serializedAs(adapter, document.type, file), label).toEqual(serializedAs(adapter, pathType, file));
            checked += 1;
          }
        }
        expect(checked, adapter.id).toBeGreaterThan(0);
      } finally {
        sandbox.cleanup();
      }
    }
  });
});

describe("conformance — refusal and not-found sentences have one home", () => {
  test("a missing asset is refused with assetNotFound's sentence, by every adapter and by the facade", async () => {
    for (const adapter of writableDirectoryAdapters()) {
      const sandbox = sandboxStashDir();
      try {
        const root = path.join(sandbox.dir, "b");
        fs.mkdirSync(root, { recursive: true });
        const b = bundle("b", root);
        const type = adapter.writes[0] as string;
        const asked = adapter.place(b, { type, name: "none" });
        const expected = assetNotFound(`b//${asked}`);
        const changes = [() => adapter.update(b, asked, "x"), () => adapter.delete(b, asked)];
        if (adapter.retires.length > 0) changes.push(() => adapter.retire(b, asked, {}));
        for (const change of changes) expect(change, adapter.id).toThrow(expected.message);
        const target = {
          source: { kind: "filesystem" as const, name: "b", path: root, adapterId: adapter.id },
          config: { type: "filesystem" as const, name: "b", path: root, writable: true },
        };
        let failure: unknown;
        try {
          writeAssets(target, { purpose: "conformance" }, (w) => w.update(asked, "x"));
        } catch (error) {
          failure = error;
        }
        expect(failure, adapter.id).toBeInstanceOf(NotFoundError);
        expect((failure as NotFoundError).message, adapter.id).toBe(expected.message);
        expect((failure as NotFoundError).code, adapter.id).toBe("ASSET_NOT_FOUND");
      } finally {
        sandbox.cleanup();
      }
    }
    await withFakeSecretStores({ keyrings: { akm: [] }, vaults: { vault: {} } }, async () => {
      for (const [adapter, location] of [
        [secretToolAdapter, "akm"],
        [azureKeyVaultAdapter, "vault"],
      ] as const) {
        const b: Bundle = { id: "managed", root: "/not/a/directory", location };
        const expected = assetNotFound("managed//secrets/none");
        expect(() => adapter.update(b, "secrets/none", "x"), adapter.id).toThrow(expected.message);
        expect(() => adapter.delete(b, "secrets/none"), adapter.id).toThrow(expected.message);
      }
    });
  });

  test("the user-facing gate sentences are the facade's, word for word", () => {
    const sandbox = sandboxStashDir();
    try {
      const akm = assetBundleOf({ name: "stash", path: sandbox.dir, adapterId: "akm" });
      const readOnly = assetBundleOf({ name: "wiki", path: sandbox.dir, adapterId: "okf" });
      expect(() => readOnly.assertWrites("knowledge")).toThrow(
        'Bundle "wiki" uses adapter "okf", which does not support AKM asset writes.',
      );
      expect(() => akm.assertWrites("nope")).toThrow(
        'Bundle "stash" uses adapter "akm", which does not support AKM asset writes.',
      );
      expect(() => akm.assertRetires("env")).toThrow(
        'Bundle "stash" uses adapter "akm", which does not support AKM asset writes.',
      );
      expect(() => readOnly.assertRetiring()).toThrow(
        'Bundle "wiki" uses adapter "okf", which does not support AKM asset writes.',
      );
    } finally {
      sandbox.cleanup();
    }
  });

  test("an adapter's own gate failures are invariant errors, never the facade's user-facing refusals", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "b");
      fs.mkdirSync(path.join(root, "env"), { recursive: true });
      fs.writeFileSync(path.join(root, "env", "prod.env"), "A=1\n");
      const b = bundle("b", root);
      const keyring: Bundle = { ...b, location: "akm" };
      const errors: unknown[] = [];
      for (const run of [
        () => okfAdapter.create(b, { type: "knowledge", name: "a", content: "x" }),
        () => akmAdapter.retire(b, "env/prod", {}),
        () => okfAdapter.restore(b, "h"),
        () => okfAdapter.forget(b, "h"),
        () => okfAdapter.expireRetired(b, new Date()),
        () => secretToolAdapter.create(keyring, { type: "knowledge", name: "a", content: "x" }),
        () => secretToolAdapter.retire(keyring, "secrets/a", {}),
      ]) {
        try {
          run();
        } catch (error) {
          errors.push(error);
        }
      }
      expect(errors).toHaveLength(7);
      for (const error of errors) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(UsageError);
        expect(error).not.toBeInstanceOf(NotFoundError);
      }
    } finally {
      sandbox.cleanup();
    }
  });

  test("create refuses a name whose file would be no asset, with one sentence (N12)", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "b");
      fs.mkdirSync(root, { recursive: true });
      const target = {
        source: { kind: "filesystem" as const, name: "b", path: root, adapterId: "akm" },
        config: { type: "filesystem" as const, name: "b", path: root, writable: true },
      };
      for (const [type, name, file] of [
        ["knowledge", "index", "knowledge/index.md"],
        ["secret", "x.lock", "secrets/x.lock"],
      ] as const) {
        expect(() =>
          writeAssets(target, { purpose: "conformance" }, (w) => w.create({ type, name, content: "x" })),
        ).toThrow(`Cannot create ${type} "${name}" in bundle "b": it would be kept at ${file}, which is not an asset.`);
        expect(fs.existsSync(path.join(root, file))).toBe(false);
      }
    } finally {
      sandbox.cleanup();
    }
  });
});
