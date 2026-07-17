// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-2.1 — parity tests for the `script` `BundleAdapter`
 * (`src/core/adapter/adapters/script-adapter.ts`) against the Chunk 0b
 * goldens (`tests/fixtures/goldens/{recognition,placement,lint}/all-types.json`).
 * See `skill-adapter.test.ts`'s header for the shared byte-for-byte-parity
 * rationale.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scriptAdapter } from "../../../src/core/adapter/adapters/script-adapter";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import { walkStashFlat } from "../../../src/indexer/walk/walker";
import { makeFsValidateContext } from "./_helpers/validate-context";

const ALL_TYPES_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");
const SCRIPTS_ROOT = path.join(ALL_TYPES_ROOT, "scripts");

const RECOGNITION_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/recognition/all-types.json"), "utf8"),
);
const PLACEMENT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/placement/all-types.json"), "utf8"),
);
const LINT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/lint/all-types.json"), "utf8"),
);

const SCRIPT_REL_PATH = "scripts/all-types-script.sh";

function scriptsComponent(): BundleComponent {
  return { id: "scripts", adapter: "script", root: SCRIPTS_ROOT, writable: true };
}

const tmpDirsToClean: string[] = [];
afterAll(() => {
  for (const dir of tmpDirsToClean) fs.rmSync(dir, { recursive: true, force: true });
});

describe("script adapter — recognition parity vs recognition/all-types.json", () => {
  test("recognizes scripts/all-types-script.sh as type script", () => {
    const component = scriptsComponent();
    const file = buildFileContext(SCRIPTS_ROOT, path.join(ALL_TYPES_ROOT, SCRIPT_REL_PATH));
    const doc = scriptAdapter.recognize(component, file);
    expect(doc).not.toBeNull();
    expect(doc?.type).toBe(RECOGNITION_GOLDEN.byRelPath[SCRIPT_REL_PATH].type);
    expect(doc?.adapterId).toBe("script");
    // scriptSpec.toCanonicalName keeps the extension (asset-spec.ts:79) —
    // unlike markdownSpec, conceptId is NOT stripped of ".sh".
    expect(doc?.conceptId).toBe("all-types-script.sh");
  });

  test("abstains (returns null) on every other all-types fixture file", () => {
    const component = scriptsComponent();
    const files = walkStashFlat(ALL_TYPES_ROOT).filter(
      (f) => f.relPath !== SCRIPT_REL_PATH && f.relPath !== "MANIFEST.json",
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const doc = scriptAdapter.recognize(component, file);
      expect(doc, `expected script adapter to abstain on ${file.relPath}`).toBeNull();
    }
  });

  test("recognizes any SCRIPT_EXTENSIONS-listed extension, not just .sh, with no directory gate required (matchers.ts classifyByExtension is extension-only)", () => {
    // A standalone temp fixture (NOT tests/fixtures/stashes/all-types/, which
    // tests/integration/goldens-recognition-placement.test.ts pins to
    // exactly 15 files) — proves recognition doesn't require a "scripts/"
    // ancestor, just a SCRIPT_EXTENSIONS-listed extension.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-script-adapter-loose-"));
    tmpDirsToClean.push(root);
    const loosePath = path.join(root, "loose-tool.py");
    fs.writeFileSync(loosePath, "#!/usr/bin/env python3\nprint('loose')\n");
    const component: BundleComponent = { id: "loose", adapter: "script", root, writable: true };
    const file = buildFileContext(root, loosePath);
    const doc = scriptAdapter.recognize(component, file);
    expect(doc).not.toBeNull();
    expect(doc?.type).toBe("script");
    expect(doc?.conceptId).toBe("loose-tool.py");
  });
});

describe("script adapter — placement parity vs placement/all-types.json", () => {
  test("placeNew reproduces scriptSpec's identity-join placement (extension kept)", () => {
    const golden = PLACEMENT_GOLDEN.byType.script;
    expect(golden.stashDir).toBe("scripts");
    const component: BundleComponent = {
      id: "scripts",
      adapter: "script",
      root: path.join(ALL_TYPES_ROOT, golden.stashDir),
      writable: true,
    };
    const result = scriptAdapter.placeNew?.(component, golden.name);
    expect(result).toBeDefined();
    const relResult = path
      .relative(ALL_TYPES_ROOT, result as string)
      .split(path.sep)
      .join("/");
    expect(relResult).toBe(golden.assetPath);
  });
});

describe("script adapter — validate() parity vs lint/all-types.json perType.script (DefaultLinter-equivalent, D2-3)", () => {
  test("validate() returns [] for the lint-clean fixture script (matches perType.script.issues, linterUsed: DefaultLinter)", async () => {
    const golden = LINT_GOLDEN.perType.script;
    expect(golden.issues).toEqual([]);
    expect(golden.linterUsed).toBe("DefaultLinter");

    const component = scriptsComponent();
    const raw = fs.readFileSync(path.join(ALL_TYPES_ROOT, SCRIPT_REL_PATH), "utf8");
    const ctx = makeFsValidateContext(SCRIPTS_ROOT);
    const diagnostics = await scriptAdapter.validate(
      component,
      [{ path: "all-types-script.sh", op: "update", after: raw }],
      ctx,
    );
    expect(diagnostics).toEqual([]);
  });
});
