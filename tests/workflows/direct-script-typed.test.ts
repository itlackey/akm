// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for P1b's typed `prepareScriptTarget()` (spec
 * docs/plans/specs/p1b-model-extraction.md §4.3), which REPLACES
 * `directScript`'s synthetic-task-YAML fabrication
 * (src/workflows/ir/source-freeze-v4.ts:288-311, R-02) with a typed preparer
 * that shares its byte/interpreter capture with `prepareTaskV3Execution`'s
 * script arm (runtime-v3.ts:440-457) instead of duplicating it.
 *
 * Two independent things are pinned here, both RED until the replacement
 * lands:
 *
 *   1. Behavioral parity ("before/after shape"): `prepareScriptTarget()`,
 *      called directly with the script's owned identity (ref/file/
 *      bundleRoot — the exact input shape spec §4.3 assigns it), produces
 *      the same ref/sha256/interpreter/byteLength/extension/bytesBase64/
 *      cwdIdentity/cwd that today's CURRENT production path (directScript +
 *      prepareTaskV3Execution) freezes for the identical script — the full
 *      set spec §4.3 requires byte-identical, not only the four it names by
 *      example. cwdIdentity/cwd are load-bearing (they feed
 *      freezeExecutableIdentity and gitIdentity at the call site,
 *      source-freeze-v4.ts:322,338) and, unlike the other fields, captured
 *      from the script's BUNDLE ROOT today (runtime-v3.ts:445), one level
 *      above the script file — a preparer using the script's own dirname
 *      instead would change frozen-plan bytes silently. The "before" values
 *      are captured by actually running the P0 R-02 fixture workflow
 *      (tests/workflows/characterization-classification.test.ts:307-338)
 *      through today's real `startWorkflowRun` → frozen-plan path, not a
 *      hand-typed guess — so the pin is provably against CURRENT behavior.
 *   2. Mechanism removal (grep-provable, spec §4.3/§9): the synthetic-YAML
 *      fabrication — the literal `schedule: "@daily"` string, the synthetic
 *      `version: 3\nuses:` task-document template, and the `parseTaskV3Yaml`
 *      call fed a `${asset.path}#${step.id}` fragment filePath — is gone from
 *      EVERY file under src/, not merely from source-freeze-v4.ts's source
 *      text. Spec §4.3/§9's acceptance criteria are literal `rg -F ... src/`
 *      greps over the WHOLE tree (`rg -F 'schedule: "@daily"' src/`, `rg -F
 *      'version: 3\nuses:' src/` — both zero hits), so a single-file scan
 *      only proves the fabrication MOVED (e.g. relocated verbatim into the
 *      new prepare/ module), not that it is GONE — this file therefore walks
 *      every src/**\/*.ts file. `src/tasks/prepare/prepare-script-target.ts`
 *      is additionally scanned structurally (imports + call expressions) for
 *      any use of `parseTaskV3Yaml` at all, since a preparer achieving the
 *      same before/after byte parity by fabricating a DIFFERENTLY WORDED
 *      synthetic document (dodging the literal-string scans above) would
 *      still violate spec §4.3's "no parseTaskV3Yaml call" requirement.
 *
 * `prepareScriptTarget` is loaded through a non-literal dynamic-import path
 * so this file stays type-checkable (`bunx tsc --noEmit` clean) before the
 * module exists — see tests/workflows/environment-v4-red.test.ts for the
 * established convention this mirrors. Section 1's fixture keeps this file
 * green on the *setup* side today (the CURRENT production path still works);
 * only the "after" half and the source-text scan are red.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resetConfigCache } from "../../src/core/config/config";
import type { FrozenDirectoryIdentity } from "../../src/execution/directory-identity";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const PREPARE_SCRIPT_TARGET_MODULE: string = "../../src/tasks/prepare/prepare-script-target";

/**
 * Hand-declared from spec §4.3's exact signature (no CURRENT symbol of this
 * name/shape exists to derive a `typeof` from — unlike prepare-split.test.ts,
 * which can tie its moved-function type to today's runtime-v3.ts export).
 * Field types otherwise borrow real, CURRENT project types
 * (`TaskV3ScriptInterpreter`, `FrozenDirectoryIdentity`) so this is not a
 * pure guess.
 */
interface PreparedScriptTarget {
  readonly ref: string;
  /**
   * `TaskV3ScriptInterpreter` at the source (scriptInterpreter()'s return
   * type), but widened to `string` here to match `before.interpreter`
   * (`FrozenWorkflowScriptTarget.interpreter: string`,
   * src/workflows/ir/schema-v4.ts:104) — the two are compared directly below.
   */
  readonly interpreter: string;
  readonly extension: string;
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly cwd: string;
  readonly cwdIdentity: FrozenDirectoryIdentity;
}

type PrepareScriptTargetModule = {
  readonly prepareScriptTarget: (input: {
    readonly ref: string;
    readonly file: string;
    readonly bundleRoot: string;
    readonly readFile: (file: string, bundleRoot?: string) => Uint8Array;
  }) => PreparedScriptTarget;
};

async function prepareScriptTargetModule(): Promise<PrepareScriptTargetModule> {
  return (await import(PREPARE_SCRIPT_TARGET_MODULE)) as PrepareScriptTargetModule;
}

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

interface ParseTaskV3YamlUsage {
  readonly importsFromSourceV3: boolean;
  readonly callsParseTaskV3Yaml: boolean;
}

/**
 * Structural scan for "does this module import or call parseTaskV3Yaml at
 * all" — AST-based (same style as the purity ratchet in
 * tests/tasks/parse-v3-adapter.test.ts:423) rather than a text-substring
 * guess, so it catches a re-fabrication that dodges the literal-string scans
 * below by wording the synthetic document differently.
 */
function scanForParseTaskV3YamlUsage(filePath: string): ParseTaskV3YamlUsage {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  let importsFromSourceV3 = false;
  let callsParseTaskV3Yaml = false;
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes("source-v3")
    ) {
      importsFromSourceV3 = true;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (calleeName === "parseTaskV3Yaml") callsParseTaskV3Yaml = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { importsFromSourceV3, callsParseTaskV3Yaml };
}

describe("prepareScriptTarget — replaces directScript's synthetic-YAML fabrication (P1b spec §4.3)", () => {
  describe("behavioral parity with the CURRENT frozen script target (before/after shape)", () => {
    let storage: IsolatedAkmStorage;
    const scriptBytes = "#!/bin/sh\nprintf direct-script\n";

    beforeEach(() => {
      storage = withIsolatedAkmStorage();
      writeWorkflowTestConfig();
      resetConfigCache();
    });

    afterEach(() => {
      resetConfigCache();
      storage.cleanup();
    });

    test("ref / sha256 / interpreter / byteLength are byte-identical to today's directScript output, for the P0 R-02 script fixture", async () => {
      // "Before": the CURRENT production path — the identical fixture used
      // by characterization-classification.test.ts's R-02 test — proves
      // what today's directScript()+prepareTaskV3Execution actually freeze,
      // rather than asserting against a hand-typed guess.
      write(storage.stashDir, "scripts/exact.sh", scriptBytes);
      write(
        storage.stashDir,
        "workflows/script-step.yml",
        [
          "name: Script step",
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "  main:",
          "    runs-on: [self-hosted]",
          "    steps:",
          "      - id: run-script",
          "        uses: scripts/exact.sh",
          "",
        ].join("\n"),
      );
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const started = await startWorkflowRun("workflows/script-step");
      const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
      const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
      const root = plan.steps[0]?.root;
      const before = root && root.kind !== "map" ? root.frozenTarget : undefined;
      expect(before?.kind).toBe("script");
      if (!before || before.kind !== "script") return;
      expect(before.ref).toMatch(/\/\/scripts\/exact\.sh$/);
      expect(Buffer.from(before.bytesBase64, "base64").toString("utf8")).toBe(scriptBytes);
      expect(before.interpreter).toBe("sh");

      // "After": prepareScriptTarget(), called directly with the script's
      // own owned identity (ref/file/bundleRoot) — the exact input shape
      // spec §4.3 assigns it (owned.ref/owned.file/owned.root), with a
      // plain filesystem read standing in for the collector's readBytes
      // (both read the identical bytes off the identical path).
      const { prepareScriptTarget } = await prepareScriptTargetModule();
      const scriptFile = path.join(storage.stashDir, "scripts", "exact.sh");
      const after = prepareScriptTarget({
        ref: before.ref,
        file: scriptFile,
        bundleRoot: storage.stashDir,
        readFile: (file) => fs.readFileSync(file),
      });

      // The four fields the spec names explicitly.
      expect(after.ref).toBe(before.ref);
      expect(after.sha256).toBe(before.contentHash);
      expect(after.interpreter).toBe(before.interpreter);
      expect(after.byteLength).toBe(before.byteLength);
      // The remaining fields spec §4.3 requires byte-identical (the full set
      // scriptResult() actually reads into FrozenWorkflowScriptTarget) —
      // including cwdIdentity/cwd, which B-23 and spec §4.3 both list and
      // which are load-bearing at the call site: scriptResult() freezes
      // `prepared.cwdIdentity` verbatim onto FrozenWorkflowScriptTarget,
      // feeds `prepared.cwdIdentity.realCwd` into
      // freezeExecutableIdentity({cwd: ...}) for the executable identity,
      // and feeds `prepared.cwdIdentity.realRoot` into gitIdentity()
      // (source-freeze-v4.ts:322,335,338). Today's script arm captures that
      // identity from the script's BUNDLE ROOT
      // (runtime-v3.ts:445's `captureDirectoryIdentity(resolved.bundleRoot)`),
      // one level above the script file itself — a preparer that captured
      // the script's own dirname instead would silently change frozen-plan
      // bytes while still passing every assertion above it, since nothing
      // else in the suite pins cwdIdentity for a script step (the P0 pin at
      // tests/workflows/characterization-classification.test.ts:307-338
      // asserts only ref/bytes/interpreter).
      expect(after.extension).toBe(before.extension);
      expect(after.bytesBase64).toBe(before.bytesBase64);
      expect(Buffer.from(after.bytesBase64, "base64").toString("utf8")).toBe(scriptBytes);
      expect(after.cwdIdentity).toEqual(before.cwdIdentity);
      expect(after.cwd).toBe(before.cwdIdentity.realCwd);
    });
  });

  describe("the synthetic-YAML fabrication is gone from src/, not merely relocated (grep-provable, spec §4.3/§9)", () => {
    // Spec §4.3/§9's acceptance criteria are literal `rg -F` greps over ALL of
    // src/ (`rg -F 'schedule: "@daily"' src/`, `rg -F 'version: 3\nuses:' src/`
    // — both zero hits), not a scan scoped to source-freeze-v4.ts alone.
    // Reading only that one file proves the fabrication MOVED (e.g. a
    // byte-for-byte copy relocated into the new prepare/ module would pass a
    // single-file scan of source-freeze-v4.ts trivially), not that it is
    // GONE — so this walks every src/**\/*.ts file, the same convention as
    // scripts/lint-import-cycles.ts's walkTsFiles / scripts/lint-license-headers.ts's collectTs.
    const SRC_ROOT = path.resolve(import.meta.dir, "../../src");

    function walkTsFiles(dir: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...walkTsFiles(full));
        else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) results.push(full);
      }
      return results;
    }

    function allSrcFiles(): ReadonlyArray<readonly [relPath: string, content: string]> {
      return walkTsFiles(SRC_ROOT).map(
        (file) => [path.relative(SRC_ROOT, file).replace(/\\/g, "/"), fs.readFileSync(file, "utf8")] as const,
      );
    }

    function offendersMatching(predicate: (content: string) => boolean): string[] {
      return allSrcFiles()
        .filter(([, content]) => predicate(content))
        .map(([relPath]) => relPath);
    }

    // CHARACTERIZATION-INVERSE (red today, per P1b spec §4.3's acceptance
    // criterion: "rg -F 'schedule: \"@daily\"' src/ ... return zero hits").
    // Today's directScript() (source-freeze-v4.ts:296-298) fabricates
    //   `version: 3\nuses: ${owned.ref}\nakm:\n  schedule: "@daily"\n`
    // purely to satisfy R-06 (exactly-one-scheduling-source) on a document
    // nothing ever schedules. prepareScriptTarget() never builds a task
    // document at all, so this literal has nothing left to appear in — ANY
    // file under src/, including a relocated copy of today's trick.
    test("the literal fabricated schedule string is absent from every file under src/", () => {
      const offenders = offendersMatching((content) => content.includes('schedule: "@daily"'));
      expect(offenders).toEqual([]);
    });

    // Today's directScript() (source-freeze-v4.ts:297-299) builds
    //   filePath: `${context.asset.path}#${source.id}`
    // and feeds it, with the fabricated YAML above, through parseTaskV3Yaml.
    // Spec §4.3: prepareScriptTarget has "no parseTaskV3Yaml call, ... no
    // fabricated filePath fragment (${asset.path}#${step.id})".
    test("the fabricated fragment filePath fed to parseTaskV3Yaml is absent from every file under src/", () => {
      // Expressed as a regex rather than a plain string literal so biome's
      // noTemplateCurlyInString rule (a forgotten-backtick guard) does not
      // mistake this deliberate, literal `${...}` needle for a broken
      // template — these files are scanned as SOURCE TEXT, so the needle
      // intentionally matches unevaluated template-literal bytes wherever
      // they appear under src/.
      const fragmentOffenders = offendersMatching((content) =>
        /\$\{context\.asset\.path\}#\$\{source\.id\}/.test(content),
      );
      expect(fragmentOffenders).toEqual([]);
      const callOffenders = offendersMatching((content) =>
        /parseTaskV3Yaml\(\{\s*yaml:\s*`version: 3\\nuses:/.test(content),
      );
      expect(callOffenders).toEqual([]);
    });

    // Weaker, content-scoped restatement of the second acceptance grep
    // (`rg -F 'version: 3\nuses:' src/` → zero hits) so a passing run is
    // legible without shelling out to ripgrep from inside the test.
    test("the synthetic 'version: 3' task-document template is absent from every file under src/", () => {
      const offenders = offendersMatching((content) => content.includes("version: 3\\nuses:"));
      expect(offenders).toEqual([]);
    });

    // NEW (test-review finding): the three scans above prove the fabrication
    // is gone from src/ TEXT, but a preparer could still reach the exact same
    // "before/after" parity (section 1 above) by fabricating a DIFFERENTLY
    // WORDED synthetic document — e.g. spelling the schedule some other way —
    // and re-parsing it through parseTaskV3Yaml, which spec §4.3 forbids
    // outright regardless of wording ("no parseTaskV3Yaml call"). So
    // prepareScriptTarget's own module is scanned STRUCTURALLY (import
    // specifiers + call expressions) for any use of parseTaskV3Yaml at all.
    describe("src/tasks/prepare/prepare-script-target.ts never imports or calls parseTaskV3Yaml (spec §4.3)", () => {
      const PREPARE_SCRIPT_TARGET_FILE = path.join(SRC_ROOT, "tasks/prepare/prepare-script-target.ts");

      test("imports nothing from source-v3 and contains no parseTaskV3Yaml(...) call", () => {
        if (!fs.existsSync(PREPARE_SCRIPT_TARGET_FILE)) {
          throw new Error(
            "src/tasks/prepare/prepare-script-target.ts does not exist yet — spec §4.3 requires it to export " +
              "prepareScriptTarget(); this test cannot pass until the module is implemented.",
          );
        }
        const usage = scanForParseTaskV3YamlUsage(PREPARE_SCRIPT_TARGET_FILE);
        expect(usage.importsFromSourceV3, "imports something from source-v3").toBe(false);
        expect(usage.callsParseTaskV3Yaml, "calls parseTaskV3Yaml(...)").toBe(false);
      });
    });

    // NEW (test-review finding): the AST scan above proves
    // prepare-script-target.ts's own module never imports/calls
    // parseTaskV3Yaml, but nothing pinned that directScript's CALL SITE
    // (source-freeze-v4.ts:288-312, where today's fabrication actually
    // lives) stopped fabricating and started calling the replacement. A
    // whole-file ban on source-freeze-v4.ts would be WRONG — taskDispatch
    // (the same file, a few lines above directScript) legitimately calls
    // parseTaskV3Yaml on a REAL task document read off disk
    // (source-freeze-v4.ts:233 at head) — R-02/spec §4.3 is only about
    // directScript's SYNTHETIC document, never about taskDispatch's real
    // one. So this scans directScript's function BODY specifically: the
    // same "locate the named function, then walk only its subtree"
    // technique as scanForParseTaskV3YamlUsage above, generalized from
    // "does this MODULE call X" to "does this FUNCTION call X".
    describe("src/workflows/freeze/targets/{script,task}.ts, post P2b split: directScript has no parseTaskV3Yaml call, a prepareScriptTarget call instead (spec §4.3)", () => {
      const SCRIPT_TARGET_FILE = path.join(SRC_ROOT, "workflows/freeze/targets/script.ts");
      const TASK_TARGET_FILE = path.join(SRC_ROOT, "workflows/freeze/targets/task.ts");

      interface FunctionCallScan {
        readonly functionFound: boolean;
        readonly calledNames: ReadonlySet<string>;
      }

      /**
       * Locates the top-level function DECLARATION named `functionName` and
       * collects every call expression's callee name from WITHIN that
       * function's body only — siblings (like taskDispatch, which
       * legitimately calls parseTaskV3Yaml on a real document) are left
       * alone, which is exactly why a whole-file ban is wrong for this file.
       */
      function scanFunctionCalls(filePath: string, functionName: string): FunctionCallScan {
        const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
        let functionFound = false;
        const calledNames = new Set<string>();
        function visitCalls(node: ts.Node): void {
          if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const calleeName = ts.isIdentifier(callee)
              ? callee.text
              : ts.isPropertyAccessExpression(callee)
                ? callee.name.text
                : undefined;
            if (calleeName) calledNames.add(calleeName);
          }
          ts.forEachChild(node, visitCalls);
        }
        function visitTop(node: ts.Node): void {
          if (ts.isFunctionDeclaration(node) && node.name?.text === functionName && node.body) {
            functionFound = true;
            visitCalls(node.body);
          }
          ts.forEachChild(node, visitTop);
        }
        visitTop(source);
        return { functionFound, calledNames };
      }

      test("directScript's body contains no parseTaskV3Yaml(...) call and does contain a prepareScriptTarget(...) call", () => {
        const scan = scanFunctionCalls(SCRIPT_TARGET_FILE, "directScript");
        expect(scan.functionFound, "directScript function declaration not found in source-freeze-v4.ts").toBe(true);
        expect(scan.calledNames.has("parseTaskV3Yaml"), "directScript still calls parseTaskV3Yaml(...)").toBe(false);
        expect(scan.calledNames.has("prepareScriptTarget"), "directScript never calls prepareScriptTarget(...)").toBe(
          true,
        );
      });

      // Sanity contrast (spec §4.3's parenthetical: "a whole-file ban is
      // wrong there — taskDispatch legitimately calls parseTaskV3Yaml"):
      // proves the scan above is genuinely function-scoped, not accidentally
      // whole-file in disguise — if it were whole-file, this fixture would
      // make a directScript-only ban indistinguishable from a file-wide one.
      //
      // UPDATED (P2b A-N6, spec docs/plans/specs/p2b-input-bindings.md §1.7):
      // recorded in the Review log as a consequence of F-A4, not a named §7
      // flip itself — F-A1's split commit re-pointed only the path constants
      // above, never this assertion. A-N6 lifted LC-N1's deferral and routed
      // taskDispatch through parseTaskSource, which parses BOTH task source
      // versions once — taskDispatch no longer calls parseTaskV3Yaml
      // directly at all, so the ORIGINAL assertion is unreachable (verified:
      // it is not in taskDispatch's own call set). The direct call
      // taskDispatch now makes toward real-document parsing is
      // resolveTaskForComposition (this file, its sibling), which itself
      // calls parseTaskSource — so the same "locate the function, walk only
      // its subtree" technique is applied one hop further to keep proving
      // the scan is function-scoped, not file-wide.
      test("taskDispatch (the same file, unrelated to R-02) still legitimately resolves a real document via resolveTaskForComposition -> parseTaskSource(...)", () => {
        const scan = scanFunctionCalls(TASK_TARGET_FILE, "taskDispatch");
        expect(scan.functionFound, "taskDispatch function declaration not found in task.ts").toBe(true);
        expect(scan.calledNames.has("resolveTaskForComposition")).toBe(true);

        const helperScan = scanFunctionCalls(TASK_TARGET_FILE, "resolveTaskForComposition");
        expect(helperScan.functionFound, "resolveTaskForComposition function declaration not found in task.ts").toBe(
          true,
        );
        expect(helperScan.calledNames.has("parseTaskSource")).toBe(true);
      });
    });
  });
});
