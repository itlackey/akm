// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The runtime port is a dependency direction, so this checks import directions.
 * Lowering, dispatch and the rest of the application reach akm's agent runtime
 * through `integrations/agent/runtime-port.ts`; the one module that names the
 * implementation is `integrations/agent/runtime.ts`. The implementation, in turn,
 * is given resolved input and reads no config.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const SRC = path.join(repoRoot, "src");

const IMPLEMENTATION = "src/integrations/harnesses/opencode/runtime/";
const COMPOSITION = "src/integrations/agent/runtime.ts";
const CONFIG_MODULES = ["src/core/config/config.ts", "src/core/config/config-types.ts"];

/** The files of a source tree, by repo-relative path. */
function sourceFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.set(path.relative(repoRoot, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(dir);
  return files;
}

/** What a source text imports, resolved to repo-relative paths without an extension (static, re-exported and dynamic). */
function importedModules(file: string, text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifiers = [...code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.[^"']*)["']/g)].map(
    (match) => match[1] ?? "",
  );
  return specifiers.map((specifier) =>
    path
      .normalize(path.join(path.dirname(file), specifier))
      .split(path.sep)
      .join("/"),
  );
}

/** Whether a repo-relative path, with or without an extension, is in the implementation's folder. */
const isImplementation = (modulePath: string): boolean => `${modulePath}/`.startsWith(IMPLEMENTATION);

/** Every way the tree breaks the port's direction, as `file imports module`. */
function violations(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    for (const imported of importedModules(file, text)) {
      if (isImplementation(imported) && !isImplementation(file) && file !== COMPOSITION) {
        found.push(`${file} imports ${imported}: only ${COMPOSITION} may name the runtime's implementation`);
      }
      if (isImplementation(file) && CONFIG_MODULES.some((config) => imported === config.replace(/\.ts$/, ""))) {
        found.push(
          `${file} imports ${imported}: the runtime implementation is given resolved input and reads no config`,
        );
      }
    }
  }
  return found;
}

describe("the agent runtime port", () => {
  const files = sourceFiles(SRC);

  test("nothing but the composition module names the runtime's implementation, and the implementation reads no config", () => {
    expect(violations(files)).toEqual([]);
  });

  test("the composition module does name it (the check is not vacuous)", () => {
    const text = files.get(COMPOSITION) ?? "";
    expect(importedModules(COMPOSITION, text).some(isImplementation)).toBe(true);
  });

  test("a module that reaches around the port, or an implementation that reads config, is reported", () => {
    const synthetic = new Map<string, string>([
      ["src/integrations/agent/execution.ts", 'import { run } from "../harnesses/opencode/runtime/command";\n'],
      [
        "src/commands/improve/other.ts",
        'const run = await import("../../integrations/harnesses/opencode/runtime/binary");\n',
      ],
      [
        "src/integrations/harnesses/opencode/runtime/command.ts",
        'import { loadConfig } from "../../../../core/config/config";\n',
      ],
      ["src/integrations/agent/runtime.ts", 'import { runtime } from "../harnesses/opencode/runtime";\n'],
      ["src/integrations/harnesses/opencode/index.ts", 'import("./runtime/command");\n'],
      [
        "src/commands/health/plugin-staleness.ts",
        'import { opencodeCacheDir } from "../../integrations/harnesses/opencode/roots";\n',
      ],
    ]);
    expect(violations(synthetic)).toEqual([
      "src/integrations/agent/execution.ts imports src/integrations/harnesses/opencode/runtime/command: only src/integrations/agent/runtime.ts may name the runtime's implementation",
      "src/commands/improve/other.ts imports src/integrations/harnesses/opencode/runtime/binary: only src/integrations/agent/runtime.ts may name the runtime's implementation",
      "src/integrations/harnesses/opencode/runtime/command.ts imports src/core/config/config: the runtime implementation is given resolved input and reads no config",
      "src/integrations/harnesses/opencode/index.ts imports src/integrations/harnesses/opencode/runtime/command: only src/integrations/agent/runtime.ts may name the runtime's implementation",
    ]);
  });
});
