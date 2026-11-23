// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Commands take their asset types and folders from the modules that own them
 * (`KNOWN_TYPES`, the placement registry, the walker's directory rules), so a
 * type added there is accepted here without a second edit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { describeUsage } from "../../src/cli/usage";
import { generateBashCompletions } from "../../src/commands/completions";
import { akmLint } from "../../src/commands/lint/index";
import {
  documentFormatForStashDir,
  documentStashDirFor,
  documentStashDirs,
  stashDirFor,
} from "../../src/core/asset/asset-placement";
import { UsageError } from "../../src/core/errors";
import { KNOWN_TYPES } from "../../src/core/recognition-util";
import { buildFileContext } from "../../src/indexer/walk/file-context";
import { declaredTypeForPath } from "../../src/indexer/walk/matchers";
import { DETAIL_LEVELS, OUTPUT_FORMATS } from "../../src/output/context";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const NEEDS_UPDATED = "---\ndescription: needs a date\n---\n\nBody.\n";

function write(root: string, rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

/** A file the walker's directory rules would place in `type`'s folder. */
function sampleFile(type: string, dir: string): string {
  if (type === "skill") return `${dir}/x/SKILL.md`;
  return `${dir}/x${documentFormatForStashDir(dir) === "yaml" ? ".yml" : ".md"}`;
}

describe("lint folders come from the placement registry", () => {
  test("every known type is either linted as a document folder or one lint never reads", () => {
    const neverRead = KNOWN_TYPES.filter((type) => {
      const dir = stashDirFor(type);
      return dir === undefined || documentFormatForStashDir(dir) === undefined;
    });
    expect([...neverRead].sort()).toEqual(["env", "script", "secret"]);
  });

  test("the walker declares each document folder's type for a file in it", () => {
    for (const type of KNOWN_TYPES) {
      const dir = stashDirFor(type);
      if (dir === undefined || !documentStashDirs().includes(dir)) continue;
      const declared = declaredTypeForPath(buildFileContext("/bundle", `/bundle/${sampleFile(type, dir)}`));
      expect({ type, declared }).toEqual({ type, declared: type });
    }
  });

  describe("sweep and single file", () => {
    let storage: IsolatedAkmStorage;
    beforeEach(() => {
      storage = withIsolatedAkmStorage();
    });
    afterEach(() => storage.cleanup());
    const lint = (extra: Record<string, unknown> = {}) =>
      akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir), ...extra });

    test("rules/ and instructions/ files are swept and linted singly", async () => {
      const rule = write(storage.stashDir, "rules/proj/a.md", NEEDS_UPDATED);
      const instruction = write(storage.stashDir, "instructions/b.md", NEEDS_UPDATED);
      const swept = await lint();
      expect(swept.flagged.map((i) => i.file).sort()).toEqual(["instructions/b.md", "rules/proj/a.md"]);
      expect((await lint({ file: rule })).flagged.map((i) => i.file)).toEqual(["rules/proj/a.md"]);
      expect((await lint({ file: instruction })).flagged.map((i) => i.file)).toEqual(["instructions/b.md"]);
    });

    test("--type rules narrows the sweep to rules/", async () => {
      write(storage.stashDir, "rules/a.md", NEEDS_UPDATED);
      write(storage.stashDir, "knowledge/b.md", NEEDS_UPDATED);
      expect((await lint({ typeFilter: "rules" })).flagged.map((i) => i.file)).toEqual(["rules/a.md"]);
    });

    test("--type takes a type name or its folder name, with the same result", async () => {
      write(storage.stashDir, "rules/a.md", NEEDS_UPDATED);
      write(storage.stashDir, "memories/b.md", NEEDS_UPDATED);
      for (const [name, folder, file] of [
        ["rule", "rules", "rules/a.md"],
        ["memory", "memories", "memories/b.md"],
      ] as const) {
        const byName = await lint({ typeFilter: name });
        const byFolder = await lint({ typeFilter: folder });
        expect(byName.flagged.map((i) => i.file)).toEqual([file]);
        expect(byName.flagged).toEqual(byFolder.flagged);
      }
    });

    test("every --type value completion offers for lint selects a folder", () => {
      const script = generateBashCompletions({
        meta: { name: "akm" },
        subCommands: { lint: { meta: { name: "lint" }, args: { type: { type: "string" } } } },
      });
      const offered = script.match(/"akm lint"\)\s*COMPREPLY=\( \$\(compgen -W "([^"]*)"/)?.[1]?.split(" ") ?? [];
      expect(offered.length).toBeGreaterThan(0);
      for (const value of offered)
        expect({ value, folder: documentStashDirFor(value) }).not.toEqual({ value, folder: undefined });
    });

    test("sessions are left out of the sweep unless named or the config stops excluding them", async () => {
      write(storage.stashDir, "sessions/h/a.md", NEEDS_UPDATED);
      const files = (r: Awaited<ReturnType<typeof lint>>) => r.flagged.map((i) => i.file);
      expect(files(await lint())).toEqual([]);
      expect(files(await lint({ typeFilter: "session" }))).toEqual(["sessions/h/a.md"]);
      const config = { ...makeConfig(storage.stashDir), search: { defaultExcludeTypes: [] } };
      expect(files(await lint({ config }))).toEqual(["sessions/h/a.md"]);
    });

    test("a file under env/ or secrets/ is refused and not read", async () => {
      const secret = write(storage.stashDir, "secrets/token.md", NEEDS_UPDATED);
      const env = write(storage.stashDir, "env/prod.env", "KEY=value\n");
      for (const file of [secret, env]) {
        await expect(lint({ file })).rejects.toBeInstanceOf(UsageError);
        await expect(lint({ file, typeFilter: "knowledge" })).rejects.toBeInstanceOf(UsageError);
      }
    });
  });
});

describe("CLI usage records every known type", () => {
  const root = { subCommands: { search: { args: { type: { type: "string" } } } } };
  const recordedType = (value: string) =>
    describeUsage(root, ["search", "--type", value]).arguments.find((arg) => arg.name === "type")?.value;

  test("each known type, and any, is recorded as given", () => {
    for (const type of [...KNOWN_TYPES, "any"]) expect(recordedType(type)).toBe(type);
  });

  test("a folder name, as lint --type takes it, is recorded as given", () => {
    const lintRoot = { subCommands: { lint: { args: { type: { type: "string" } } } } };
    const value = describeUsage(lintRoot, ["lint", "--type", "memories"]).arguments.find(
      (a) => a.name === "type",
    )?.value;
    expect(value).toBe("memories");
  });

  test("a value that is not a type is redacted", () => {
    expect(recordedType("PRIVATE_VALUE")).toBe("[redacted]");
  });
});

describe("--format, --detail and --type values come from their owners", () => {
  const usageRoot = {
    subCommands: { show: { args: { format: { type: "string" }, detail: { type: "string" } } } },
  };
  test("usage records every output format and detail value", () => {
    for (const [flag, values] of [
      ["format", OUTPUT_FORMATS],
      ["detail", DETAIL_LEVELS],
    ] as const) {
      for (const value of values) {
        const recorded = describeUsage(usageRoot, ["show", `--${flag}`, value]).arguments.find((a) => a.name === flag);
        expect(recorded?.value).toBe(value);
      }
    }
  });

  test("completions offer every format, detail value and known type", () => {
    const script = generateBashCompletions({
      meta: { name: "akm" },
      subCommands: {
        show: {
          meta: { name: "show" },
          args: { format: { type: "string" }, detail: { type: "string" }, type: { type: "string" } },
        },
      },
    });
    const offered = (flag: string): string[] => {
      const at = script.indexOf(`\n    ${flag})`);
      return (script.slice(at).match(/compgen -W "([^"]*)"/)?.[1] ?? "").split(" ");
    };
    expect(offered("--format")).toEqual([...OUTPUT_FORMATS]);
    expect(offered("--detail")).toEqual([...DETAIL_LEVELS]);
    const anyCommand = script
      .slice(script.indexOf("\n    --type)"))
      .match(/\*\)\s*COMPREPLY=\( \$\(compgen -W "([^"]*)"/)?.[1];
    for (const type of [...KNOWN_TYPES, "any"]) expect(anyCommand?.split(" ")).toContain(type);
  });
});
