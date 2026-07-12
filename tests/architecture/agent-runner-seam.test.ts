import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveEngine } from "../../src/integrations/agent/engine-resolution";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { executeRunner } from "../../src/integrations/agent/runner-dispatch";

const profile: AgentProfile = {
  name: "runner-test-agent",
  bin: "runner-test-agent",
  args: [],
  stdio: "captured",
  envPassthrough: ["PATH"],
  parseOutput: "text",
};

const result = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1 });

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const srcRoot = path.join(repoRoot, "src");
const dispatchAuthority = path.join("integrations", "agent", "runner-dispatch.ts");

function productionTypeScriptFiles(dir = srcRoot): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

function productionSource(filePath: string): string {
  return fs
    .readFileSync(filePath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function relativeSourcePath(filePath: string): string {
  return path.relative(srcRoot, filePath);
}

function hasLowLevelRunnerReference(source: string): boolean {
  if (!/\b(?:runAgent|runOpencodeSdk)\b/.test(source)) return false;
  const lowLevelNames = new Set(["runAgent", "runOpencodeSdk"]);
  const sourceFile = ts.createSourceFile("guard.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && lowLevelNames.has(node.text)) {
      // RunnerSeams uses these as object keys when supplying dispatch overrides;
      // the value expression, imports, aliases, and property access remain guarded.
      if (!(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
        found = true;
        return;
      }
    }
    if (
      ts.isStringLiteral(node) &&
      lowLevelNames.has(node.text) &&
      ts.isElementAccessExpression(node.parent) &&
      node.parent.argumentExpression === node
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("RunnerSpec dispatch authority", () => {
  test("routes an sdk spec through the SDK path", async () => {
    const spec: RunnerSpec = { kind: "sdk", profile };
    const actual = await executeRunner(
      spec,
      "hello",
      {},
      {
        runAgent: async () => result("spawn"),
        runSdk: async () => result("sdk"),
      },
    );
    expect(actual.stdout).toBe("sdk");
  });

  test("routes an agent spec through the spawn path", async () => {
    const spec: RunnerSpec = { kind: "agent", profile };
    const actual = await executeRunner(
      spec,
      "hello",
      {},
      {
        runAgent: async () => result("spawn"),
        runSdk: async () => result("sdk"),
      },
    );
    expect(actual.stdout).toBe("spawn");
  });

  test("engine lowering, not profile fields, selects SDK versus spawn", () => {
    const config = {
      engines: {
        agent: { kind: "agent" as const, platform: "opencode" },
        sdk: { kind: "agent" as const, platform: "opencode-sdk", llmEngine: "llm" },
        llm: { kind: "llm" as const, endpoint: "https://example.test/v1/chat/completions", model: "test" },
      },
      defaults: { engine: "agent", llmEngine: "llm" },
    };
    expect(resolveEngine("agent", config).kind).toBe("agent");
    expect(resolveEngine("sdk", config).kind).toBe("sdk");
  });

  test("every production dispatch consumer calls executeRunner", () => {
    const consumers = productionTypeScriptFiles()
      .filter((filePath) => relativeSourcePath(filePath) !== dispatchAuthority)
      .filter((filePath) => /\bexecuteRunner\s*\(/.test(productionSource(filePath)))
      .map(relativeSourcePath)
      .sort();

    expect(consumers).toEqual(
      [
        path.join("commands", "agent", "agent-dispatch.ts"),
        path.join("commands", "improve", "reflect.ts"),
        path.join("commands", "proposal", "drain.ts"),
        path.join("commands", "proposal", "propose.ts"),
        path.join("tasks", "runner.ts"),
        path.join("workflows", "exec", "native-executor.ts"),
      ].sort(),
    );
  });

  test("low-level agent runners have no production references outside runner-dispatch", () => {
    const implementations = new Set([
      dispatchAuthority,
      path.join("integrations", "agent", "spawn.ts"),
      path.join("integrations", "harnesses", "opencode-sdk", "index.ts"),
      path.join("integrations", "harnesses", "opencode-sdk", "sdk-runner.ts"),
    ]);
    const violations = productionTypeScriptFiles()
      .filter((filePath) => !implementations.has(relativeSourcePath(filePath)))
      .filter((filePath) => hasLowLevelRunnerReference(productionSource(filePath)))
      .map(relativeSourcePath);

    expect(violations).toEqual([]);
  });

  test("low-level runner reference guard catches aliased imports", () => {
    const aliasedImports = [
      `import { runAgent as invoke } from "./spawn";`,
      `import { runOpencodeSdk as invokeSdk } from "./sdk-runner";`,
      `const { runAgent: dynamicAlias } = await import("./spawn");`,
    ].join("\n");
    expect(hasLowLevelRunnerReference(aliasedImports)).toBe(true);
  });

  test("the RunnerSpec three-kind switch exists only at the dispatch authority", () => {
    const switches = productionTypeScriptFiles()
      .filter((filePath) => {
        const source = productionSource(filePath);
        return ["llm", "agent", "sdk"].every((kind) => new RegExp(`case\\s+["']${kind}["']\\s*:`).test(source));
      })
      .map(relativeSourcePath);

    expect(switches).toEqual([dispatchAuthority]);
  });
});
