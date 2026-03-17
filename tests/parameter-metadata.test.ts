import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, getAllEntries, openDatabase } from "../src/db";
import { akmIndex, buildSearchText } from "../src/indexer";
import type { StashEntry } from "../src/metadata";
import { extractCommandParameters, generateMetadataFlat } from "../src/metadata";
import { getDbPath } from "../src/paths";

let testConfigDir = "";
let testCacheDir = "";
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-param-config-"));
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-param-cache-"));
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_CACHE_HOME = testCacheDir;

  const dbPath = getDbPath();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
});

function tmpStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-param-"));
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ── Test 1: Commands with $1, $2 have parameters auto-extracted ──────────

describe("command parameter extraction", () => {
  test("commands with $1 and $2 have parameters auto-extracted", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "commands", "deploy.md"),
      '---\ndescription: "Deploy a Docker image"\n---\nDeploy $1 to environment $2\n',
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "commands", "deploy.md")]);

    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry.parameters).toBeDefined();
    expect(entry.parameters?.length).toBe(2);
    expect(entry.parameters?.[0].name).toBe("$1");
    expect(entry.parameters?.[1].name).toBe("$2");
  });

  test("commands with $ARGUMENTS have parameters auto-extracted", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "commands", "run.md"),
      '---\ndescription: "Run a command"\n---\nExecute the following with $ARGUMENTS\n',
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "commands", "run.md")]);

    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry.parameters).toBeDefined();
    expect(entry.parameters?.some((p) => p.name === "ARGUMENTS")).toBe(true);
  });

  test("commands with {{named}} placeholders have parameters auto-extracted", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "commands", "build.md"),
      '---\ndescription: "Build image"\n---\ndocker build -t {{image_name}} --platform {{platform}} .\n',
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "commands", "build.md")]);

    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry.parameters).toBeDefined();
    expect(entry.parameters?.some((p) => p.name === "image_name")).toBe(true);
    expect(entry.parameters?.some((p) => p.name === "platform")).toBe(true);
  });
});

// ── Test 2: Scripts with @param JSDoc have parameters extracted ──────────

describe("script @param extraction", () => {
  test("scripts with @param JSDoc have parameters extracted", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "scripts", "deploy.ts"),
      [
        "/**",
        " * Deploy to production",
        " * @param name - The deployment name",
        " * @param environment - Target environment (staging or production)",
        " */",
        "console.log('deploy')",
      ].join("\n"),
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "scripts", "deploy.ts")]);

    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry.parameters).toBeDefined();
    expect(entry.parameters?.length).toBe(2);
    expect(entry.parameters?.[0].name).toBe("name");
    expect(entry.parameters?.[0].description).toBe("The deployment name");
    expect(entry.parameters?.[1].name).toBe("environment");
    expect(entry.parameters?.[1].description).toBe("Target environment (staging or production)");
  });

  test("scripts with typed @param have type extracted", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "scripts", "resize.ts"),
      [
        "/**",
        " * Resize an image",
        " * @param {string} filename - The image file path",
        " * @param {number} width - Target width in pixels",
        " */",
        "console.log('resize')",
      ].join("\n"),
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "scripts", "resize.ts")]);

    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry.parameters).toBeDefined();
    expect(entry.parameters?.length).toBe(2);
    expect(entry.parameters?.[0].name).toBe("filename");
    expect(entry.parameters?.[0].type).toBe("string");
    expect(entry.parameters?.[0].description).toBe("The image file path");
    expect(entry.parameters?.[1].name).toBe("width");
    expect(entry.parameters?.[1].type).toBe("number");
    expect(entry.parameters?.[1].description).toBe("Target width in pixels");
  });

  test("bash scripts with # @param have parameters extracted", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "scripts", "backup.sh"),
      [
        "#!/bin/bash",
        "# Backup database",
        "# @param source - The source database name",
        "# @param destination - The backup destination path",
        "echo 'backup'",
      ].join("\n"),
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "scripts", "backup.sh")]);

    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry.parameters).toBeDefined();
    expect(entry.parameters?.length).toBe(2);
    expect(entry.parameters?.[0].name).toBe("source");
    expect(entry.parameters?.[0].description).toBe("The source database name");
    expect(entry.parameters?.[1].name).toBe("destination");
    expect(entry.parameters?.[1].description).toBe("The backup destination path");
  });
});

// ── Test 3: Frontmatter params key is parsed into parameters ─────────────

describe("frontmatter params extraction", () => {
  test("frontmatter params key is parsed into parameters", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "commands", "provision.md"),
      [
        "---",
        'description: "Provision infrastructure"',
        "params:",
        "  region: AWS region to deploy to",
        "  instance_type: EC2 instance type",
        "---",
        "Provision $1 in $2",
      ].join("\n"),
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "commands", "provision.md")]);

    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry.parameters).toBeDefined();
    expect(entry.parameters?.some((p) => p.name === "region" && p.description === "AWS region to deploy to")).toBe(
      true,
    );
    expect(entry.parameters?.some((p) => p.name === "instance_type" && p.description === "EC2 instance type")).toBe(
      true,
    );
  });
});

// ── Test 4: Parameter names are included in search text ──────────────────

describe("parameter search text inclusion", () => {
  test("parameter names and descriptions are included in search text", () => {
    const entry: StashEntry = {
      name: "deploy",
      type: "command",
      description: "Deploy a service",
      parameters: [
        { name: "image_name", description: "Docker image name to deploy" },
        { name: "environment", description: "Target environment" },
      ],
    };

    const text = buildSearchText(entry);
    expect(text).toContain("image_name");
    expect(text).toContain("docker image name to deploy");
    expect(text).toContain("environment");
    expect(text).toContain("target environment");
  });
});

// ── Test 5: Assets without parameters have undefined parameters field ────

describe("no parameters", () => {
  test("assets without parameters have undefined parameters field", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "knowledge", "guide.md"),
      '---\ndescription: "A guide"\n---\n# Getting Started\nIntro.\n',
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "knowledge", "guide.md")]);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].parameters).toBeUndefined();
  });
});

// ── Test 6: Multiple parameters are extracted in order ───────────────────

describe("parameter ordering", () => {
  test("multiple parameters are extracted in order", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "commands", "multi.md"),
      '---\ndescription: "Multi param command"\n---\nRun $1 then $2 then $3 with $ARGUMENTS\n',
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "commands", "multi.md")]);

    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry.parameters).toBeDefined();
    // $ARGUMENTS comes first (matches existing extractParameters logic), then $1, $2, $3
    const names = entry.parameters?.map((p) => p.name);
    expect(names).toEqual(["ARGUMENTS", "$1", "$2", "$3"]);
  });
});

// ── Test 7: Parameter descriptions are captured ──────────────────────────

describe("parameter descriptions", () => {
  test("JSDoc @param descriptions are captured accurately", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "scripts", "transform.ts"),
      [
        "/**",
        " * Transform data",
        " * @param inputFile - Path to the input CSV file",
        " * @param outputFormat - Output format (json, xml, yaml)",
        " * @param verbose - Enable verbose logging",
        " */",
        "console.log('transform')",
      ].join("\n"),
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "scripts", "transform.ts")]);

    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry.parameters).toBeDefined();
    expect(entry.parameters?.length).toBe(3);
    expect(entry.parameters?.[0]).toEqual({ name: "inputFile", description: "Path to the input CSV file" });
    expect(entry.parameters?.[1]).toEqual({ name: "outputFormat", description: "Output format (json, xml, yaml)" });
    expect(entry.parameters?.[2]).toEqual({ name: "verbose", description: "Enable verbose logging" });
  });
});

// ── Test 8: validateStashEntry round-trips parameters ────────────────────

describe("validateStashEntry with parameters", () => {
  test("validateStashEntry preserves valid parameters", async () => {
    const { validateStashEntry } = await import("../src/metadata");

    const raw = {
      name: "test-cmd",
      type: "command",
      parameters: [
        { name: "image", type: "string", description: "Docker image", required: true, default: "latest" },
        { name: "count", type: "number", description: "Instance count" },
      ],
    };

    const entry = validateStashEntry(raw);
    expect(entry).not.toBeNull();
    expect(entry?.parameters).toBeDefined();
    expect(entry?.parameters?.length).toBe(2);
    expect(entry?.parameters?.[0].name).toBe("image");
    expect(entry?.parameters?.[0].type).toBe("string");
    expect(entry?.parameters?.[0].description).toBe("Docker image");
    expect(entry?.parameters?.[0].required).toBe(true);
    expect(entry?.parameters?.[0].default).toBe("latest");
    expect(entry?.parameters?.[1].name).toBe("count");
    expect(entry?.parameters?.[1].type).toBe("number");
  });

  test("validateStashEntry filters invalid parameter objects", async () => {
    const { validateStashEntry } = await import("../src/metadata");

    const raw = {
      name: "test-cmd",
      type: "command",
      parameters: [
        { name: "valid", description: "A valid param" },
        { notAName: "invalid" }, // missing name field
        "just a string", // not an object
        null,
      ],
    };

    const entry = validateStashEntry(raw);
    expect(entry).not.toBeNull();
    expect(entry?.parameters).toBeDefined();
    expect(entry?.parameters?.length).toBe(1);
    expect(entry?.parameters?.[0].name).toBe("valid");
  });
});

// ── Test 9: Full indexing pipeline includes parameters in search text ────

describe("indexing pipeline with parameters", () => {
  test("indexed command entries include parameters in search text", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "commands", "docker-deploy.md"),
      '---\ndescription: "Deploy Docker container"\n---\nDeploy $1 to $2 using {{registry_url}}\n',
    );

    process.env.AKM_STASH_DIR = stashDir;
    await akmIndex({ stashDir });

    const db = openDatabase();
    const entries = getAllEntries(db, "command");
    expect(entries.length).toBe(1);

    // The search text stored in the DB should include parameter names
    const searchText = entries[0].searchText;
    expect(searchText).toContain("registry_url");
    closeDatabase(db);
  });
});

// ── Test 10: Knowledge articles should NOT have command parameters extracted ──

describe("knowledge articles skip command parameter extraction", () => {
  test("knowledge article with {{variable}} should NOT have parameters extracted", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "knowledge", "template-guide.md"),
      [
        "---",
        'description: "Template syntax guide"',
        "---",
        "# Template Guide",
        "",
        "Use {{variable}} placeholders in your templates.",
        "For example: {{project_name}} and {{region}}.",
      ].join("\n"),
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "knowledge", "template-guide.md")]);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].type).toBe("knowledge");
    // Knowledge articles should NOT have command parameters extracted
    expect(result.entries[0].parameters).toBeUndefined();
  });

  test("knowledge article with frontmatter params should still have parameters", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "knowledge", "config-ref.md"),
      [
        "---",
        'description: "Configuration reference"',
        "params:",
        "  api_key: Your API key",
        "---",
        "# Configuration",
        "",
        "Set {{api_key}} in your config file.",
      ].join("\n"),
    );

    const result = await generateMetadataFlat(stashDir, [path.join(stashDir, "knowledge", "config-ref.md")]);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].type).toBe("knowledge");
    // Frontmatter params: should still be extracted for all types
    expect(result.entries[0].parameters).toBeDefined();
    expect(result.entries[0].parameters?.length).toBe(1);
    expect(result.entries[0].parameters?.[0].name).toBe("api_key");
    // But {{api_key}} from the body should NOT be extracted (not a command)
  });
});

// ── Test 11: Positional regex should not match $10 as $1 ─────────────────

describe("positional parameter boundary matching", () => {
  test("$10 should not produce a $1 parameter", () => {
    const params = extractCommandParameters("Process $10 items");
    expect(params).toBeUndefined();
  });

  test("$1 followed by non-digit is still matched", () => {
    const params = extractCommandParameters("Deploy $1 to $2");
    expect(params).toBeDefined();
    expect(params?.length).toBe(2);
    expect(params?.[0].name).toBe("$1");
    expect(params?.[1].name).toBe("$2");
  });

  test("$1 at end of string is matched", () => {
    const params = extractCommandParameters("Deploy $1");
    expect(params).toBeDefined();
    expect(params?.length).toBe(1);
    expect(params?.[0].name).toBe("$1");
  });
});
