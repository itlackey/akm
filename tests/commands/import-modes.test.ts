// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { importTaskFile } from "../../src/commands/sources/import-task";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import { getConfigPath } from "../../src/core/paths";
import { runCliStatus } from "../_helpers/cli";
import { makeSandboxDir, withIsolatedAkmStorage } from "../_helpers/sandbox";

const source = `# keep authored metadata and target inputs\nversion: 4\nname: Authored task\ndescription: Preserve me\ntags: [imported]\ninputs:\n  message:\n    type: string\n    default: hello\nrun: echo hello\nschedule: '0 9 * * *'\n`;

function fixture(enabled?: string[]) {
  const iso = withIsolatedAkmStorage();
  const dir = makeSandboxDir("akm-import-modes");
  const bundle = path.join(dir.dir, "bundle");
  fs.mkdirSync(path.join(bundle, "tasks"), { recursive: true });
  const file = path.join(dir.dir, "authored.yml");
  fs.writeFileSync(file, source);
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "target",
    bundles: { target: { path: bundle, writable: true } },
    ...(enabled === undefined ? {} : { scheduler: { enabled } }),
  });
  return {
    bundle,
    file,
    cleanup() {
      dir.cleanup();
      iso.cleanup();
    },
  };
}

test("typed import preserves authored source and clears stale explicit activation for a new task", async () => {
  const f = fixture(["target//tasks/authored", "target//tasks/other"]);
  try {
    const result = await importTaskFile({ source: f.file });
    expect(fs.readFileSync(result.path, "utf8")).toBe(source);
    expect(result.ref).toBe("target//tasks/authored");
    expect(loadConfig().scheduler?.enabled).toEqual(["target//tasks/other"]);
  } finally {
    f.cleanup();
  }
});

for (const enabled of [undefined, [], ["target//tasks/authored"]]) {
  test(`overwrite preserves activation ${JSON.stringify(enabled)}`, async () => {
    const f = fixture(enabled);
    try {
      const output = path.join(f.bundle, "tasks", "authored.yml");
      fs.writeFileSync(output, "old");
      await expect(importTaskFile({ source: f.file })).rejects.toThrow("already exists");
      expect(fs.readFileSync(output, "utf8")).toBe("old");
      await importTaskFile({ source: f.file, force: true });
      expect(loadConfig().scheduler?.enabled).toEqual(enabled);
      expect(fs.readFileSync(output, "utf8")).toBe(source);
    } finally {
      f.cleanup();
    }
  });
}

test("invalid task schema and incompatible flags fail before writes or activation changes", async () => {
  const f = fixture(["target//tasks/authored"]);
  try {
    await expect(importTaskFile({ source: "-" })).rejects.toThrow("local task definition file");
    await expect(importTaskFile({ source: "https://example.com/task.yml" })).rejects.toThrow(
      "local task definition file",
    );
    fs.writeFileSync(f.file, "version: 3\nrun: echo hi\n");
    await expect(importTaskFile({ source: f.file })).rejects.toThrow("TASK_SCHEMA_VERSION_UNSUPPORTED");
    for (const flags of [
      ["--type", "task", "--dest", "out"],
      ["--type", "unknown"],
      ["--asset-ref", "--type", "task"],
      ["--asset-ref", "--xref", "missing"],
      ["--dest", "out"],
    ]) {
      const result = await runCliStatus(["import", "/missing/file", ...flags]);
      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain("ENOENT");
    }
    expect(fs.readdirSync(path.join(f.bundle, "tasks"))).toEqual([]);
    expect(loadConfig().scheduler?.enabled).toEqual(["target//tasks/authored"]);
  } finally {
    f.cleanup();
  }
});

test("CLI typed file import supports rename and force; untyped YAML stays a knowledge document", async () => {
  const f = fixture([]);
  try {
    expect((await runCliStatus(["import", f.file, "--type", "task", "--name", "renamed"])).status).toBe(0);
    expect(fs.readFileSync(path.join(f.bundle, "tasks", "renamed.yml"), "utf8")).toBe(source);
    expect((await runCliStatus(["import", f.file, "--type", "task", "--name", "renamed", "--force"])).status).toBe(0);
    const legacy = await runCliStatus(["import", f.file, "--name", "document"]);
    expect(legacy.status).toBe(0);
    expect(JSON.parse(legacy.stdout).ref).toContain("knowledge/document");
  } finally {
    f.cleanup();
  }
});

test("typed import reports missing files and directories as input errors without writes", async () => {
  const f = fixture([]);
  try {
    for (const input of [path.join(f.bundle, "missing.yml"), f.bundle]) {
      const result = await runCliStatus(["import", input, "--type", "task"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("readable task definition file");
    }
    expect(fs.readdirSync(path.join(f.bundle, "tasks"))).toEqual([]);
    expect(loadConfig().scheduler?.enabled).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("asset-ref CLI delegates clone's type, companion files, provenance, rename and overwrite behavior", async () => {
  const f = fixture([]);
  const origin = makeSandboxDir("akm-import-origin");
  const unmanaged = makeSandboxDir("akm-import-unmanaged");
  try {
    const skill = path.join(origin.dir, "skills", "review");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n# Review\n");
    fs.writeFileSync(path.join(skill, "helper.txt"), "companion\n");
    const config = loadConfig();
    saveConfig({ ...config, bundles: { ...config.bundles, origin: { path: origin.dir } } });
    const args = ["import", "origin//skills/review", "--asset-ref", "--bundle", "target", "--name", "renamed"];
    const result = await runCliStatus(args);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.destination.ref).toContain("skills/renamed");
    expect(fs.readFileSync(path.join(f.bundle, "skills", "renamed", "helper.txt"), "utf8")).toBe("companion\n");
    expect(fs.readFileSync(payload.destination.path, "utf8")).toContain("origin//skills/review");
    expect((await runCliStatus(args)).status).toBe(2);
    expect((await runCliStatus([...args, "--force"])).status).toBe(0);
    const copied = await runCliStatus([
      "import",
      "origin//skills/review",
      "--asset-ref",
      "--dest",
      unmanaged.dir,
      "--format",
      "text",
    ]);
    expect(copied.status).toBe(0);
    expect(copied.stdout).not.toContain("[object Object]");
    expect(copied.stdout).toContain(unmanaged.dir);
    expect(fs.readFileSync(path.join(unmanaged.dir, "skills", "review", "helper.txt"), "utf8")).toBe("companion\n");
    expect((await runCliStatus([...args, "--dest", unmanaged.dir])).status).toBe(2);
  } finally {
    unmanaged.cleanup();
    origin.cleanup();
    f.cleanup();
  }
});

for (const enabled of [["target//tasks/authored"]]) {
  test(`config write failure leaves a new task absent: ${JSON.stringify(enabled)}`, async () => {
    const f = fixture(enabled);
    const configPath = getConfigPath();
    const rename = fs.renameSync;
    const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === configPath) throw new Error("injected config write failure");
      return rename(from, to);
    });
    try {
      await expect(importTaskFile({ source: f.file })).rejects.toThrow("injected config write failure");
      expect(fs.readdirSync(path.join(f.bundle, "tasks"))).toEqual([]);
    } finally {
      failure.mockRestore();
      f.cleanup();
    }
  });
}
