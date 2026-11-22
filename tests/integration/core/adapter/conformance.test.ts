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
import { DirectoryAdapterBase } from "../../../../src/core/adapter/directory-adapter";
import { adapterForId, getAdapters } from "../../../../src/core/adapter/registry";
import type { Bundle, IndexDocument } from "../../../../src/core/adapter/types";
import { buildFileContext } from "../../../../src/indexer/walk/file-context";
import { walkStashFlat } from "../../../../src/indexer/walk/walker";
import { withFakeSecretStores } from "../../../_helpers/fake-secret-stores";
import { findInBundle } from "../../../_helpers/find-in-bundle";
import { readCandidates } from "../../../_helpers/read-candidates";
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
  for (const file of walkStashFlat(c.root)) {
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

describe("conformance — read candidates and recognition are two-way canonical peers", () => {
  test("every registered adapter maps each recognized fixture file back from its canonical concept", () => {
    for (const adapter of directoryAdapters()) {
      const root = OWN_ROOT_BY_ID[adapter.id]!;
      const c = bundle(adapter.id, root);
      for (const file of walkStashFlat(root)) {
        const document = adapter.recognize(c, file);
        if (!document?.conceptId) continue;
        const candidates = readCandidates(adapter, c, document.conceptId);
        expect(
          candidates.some(
            (candidate) =>
              candidate.conceptId === document.conceptId && path.resolve(candidate.path) === path.resolve(file.absPath),
          ),
          `${adapter.id}:${document.conceptId} must include ${file.relPath}`,
        ).toBe(true);
      }
    }
  });

  test("every existing fixture candidate either abstains or recognizes the queried canonical concept", () => {
    for (const adapter of directoryAdapters()) {
      const root = OWN_ROOT_BY_ID[adapter.id]!;
      const c = bundle(adapter.id, root);
      for (const file of walkStashFlat(root)) {
        const indexed = adapter.recognize(c, file);
        if (!indexed?.conceptId) continue;
        for (const candidate of readCandidates(adapter, c, indexed.conceptId)) {
          expect(candidate.conceptId, `${adapter.id}:${candidate.path}`).toBe(indexed.conceptId);
          if (!fs.existsSync(candidate.path)) continue;
          const recognized = adapter.recognize(c, buildFileContext(root, candidate.path));
          if (recognized) expect(recognized.conceptId, `${adapter.id}:${candidate.path}`).toBe(indexed.conceptId);
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
      // Two spellings: the first by code point wins (generic-files places nothing): `.TEXT` sorts before `.md`.
      expect(findInBundle({ name: "test", path: genericRoot }, "generic-files", "docs/format")?.entry.file).toBe(
        upperText,
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
      expect(readCandidates(dotenvAdapter, dotenvComponent, "env/default")).toContainEqual({
        path: defaultEnv,
        conceptId: "env/default",
      });
      fs.writeFileSync(path.join(dotenvRoot, "env", ".sensitive"), "");
      expect(dotenvAdapter.recognize(dotenvComponent, buildFileContext(dotenvRoot, defaultEnv))).toBeNull();
      expect(findInBundle({ name: "test", path: dotenvRoot }, "dotenv", "env/default")).toMatchObject({
        listed: false,
      });

      const toolComponent = bundle("tool", toolRoot);
      const singular = path.join(toolRoot, "skill", "pkg", "SKILL.md");
      fs.mkdirSync(path.dirname(singular), { recursive: true });
      fs.writeFileSync(singular, "---\nname: pkg\ndescription: pkg\n---\n");
      expect(opencodeAdapter.recognize(toolComponent, buildFileContext(toolRoot, singular))).toBeNull();
      expect(readCandidates(opencodeAdapter, toolComponent, "skill/pkg")).toEqual([]);

      const canonicalSkill = path.join(toolRoot, "skills", "pkg", "SKILL.md");
      fs.mkdirSync(path.dirname(canonicalSkill), { recursive: true });
      fs.writeFileSync(canonicalSkill, "---\nname: pkg\ndescription: pkg\n---\n");
      expect(opencodeAdapter.recognize(toolComponent, buildFileContext(toolRoot, canonicalSkill))?.conceptId).toBe(
        "skills/pkg",
      );
      expect(readCandidates(opencodeAdapter, toolComponent, "skills/pkg")[0]).toEqual({
        path: canonicalSkill,
        conceptId: "skills/pkg",
      });
      const nested = path.join(toolRoot, "skills", "pkg", "nested", "SKILL.md");
      fs.mkdirSync(path.dirname(nested), { recursive: true });
      fs.writeFileSync(nested, "---\nname: nested\ndescription: nested\n---\n");
      expect(opencodeAdapter.recognize(toolComponent, buildFileContext(toolRoot, nested))).toBeNull();
      expect(readCandidates(opencodeAdapter, toolComponent, "skills/pkg/nested")).toEqual([]);
    } finally {
      sandbox.cleanup();
    }
  });

  test("real recognition mechanically resolves every noncanonical AKM omission and nested dotenv default", () => {
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

      // The owner is chosen from paths; only the one chosen file is read, for its type.
      for (const entry of expected) {
        expect(
          findInBundle({ name: "test", path: entry.root }, entry.adapterId, entry.conceptId),
          entry.conceptId,
        ).toMatchObject({
          entry: { file: entry.path },
          conceptId: entry.conceptId,
        });
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

  test("two files that invert to one ref read as the one place gives, and the other is ignored", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const loose = path.join(root, "tasks", "same.md");
      const canonical = path.join(root, "tasks", "same.yml");
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(loose, "Use $ARGUMENTS exactly.\n");
      fs.writeFileSync(canonical, "name: same\n");
      const owner = findInBundle({ name: "test", path: root }, "akm", "tasks/same");
      expect(owner?.entry.file).toBe(canonical);
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
        const { entries, complete } = adapter.list(b);
        expect(complete, adapter.id).toBe(true);
        expect(entries.length, adapter.id).toBe(1);
        const [entry] = entries;
        expect(entry?.file, adapter.id).toBeUndefined();
        expect(entry?.relPath.startsWith("secrets/"), adapter.id).toBe(true);
        const document = adapter.recognize(b, entry as NonNullable<typeof entry>);
        expect(document?.type, adapter.id).toBe("secret");
        expect(document, adapter.id).not.toHaveProperty("path");
      }
    });
  });
});
