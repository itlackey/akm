import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveRefToken } from "../src/commands/env/env-binding";
import { akmAdapter } from "../src/core/adapter/adapters/akm-adapter";
import { assetPathCandidatesForName, filesForRef, placementTypes, refForFile } from "../src/core/asset/asset-placement";
import { loadConfig, resetConfigCache } from "../src/core/config/config";
import { isInstalledBundle, resolveEnvPath, resolveRefOwner } from "../src/core/env-secret-ref";
import { substituteRefTokens } from "../src/core/ref-token";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveAdapterConceptOwner, resolveConceptOwner } from "../src/indexer/lookup/adapter-concept-owner";
import { resolveSourceEntries } from "../src/indexer/search/search-source";
import { buildFileContext } from "../src/indexer/walk/file-context";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";
import { withSeam } from "./_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  _resetWarnOnceForTests();
});

afterEach(() => storage.cleanup());

function write(rel: string, content = "x\n"): string {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const component = () => ({ id: "akm", adapter: "akm", root: storage.stashDir, writable: false });

describe("the placement pair: a file's ref and the files a ref can name", () => {
  // One sample file per placement type, in its type folder and out of it.
  const samples: Array<[type: string, rel: string, ref: string]> = [
    ["knowledge", "knowledge/auth.md", "knowledge/auth"],
    ["knowledge", "projects/openpalm/knowledge/auth.md", "projects/openpalm/knowledge/auth"],
    ["agent", "tools/agents/foo.md", "tools/agents/foo"],
    ["skill", "skills/review/SKILL.md", "skills/review"],
    ["skill", "tools/skills/review/SKILL.md", "tools/skills/review"],
    ["script", "scripts/run.sh", "scripts/run.sh"],
    ["script", "reports/data.js", "reports/data.js"],
    ["workflow", "workflows/release.md", "workflows/release"],
    ["env", "env/prod.env", "env/prod"],
    ["env", "env/.env", "env/default"],
    ["env", "team/env/.env", "team/env/default"],
    ["secret", "secrets/key.pem", "secrets/key.pem"],
    ["secret", "projects/x/secrets/token", "projects/x/secrets/token"],
    ["task", "tasks/nightly.yml", "tasks/nightly"],
    ["memory", "memories/vpn.md", "memories/vpn"],
    ["lesson", "WORK/lessons/x.md", "WORK/lessons/x"],
  ];

  test.each(samples)("%s %s has the ref %s, and inverting the ref yields the file", (type, rel, ref) => {
    const root = path.join(path.sep, "bundle");
    const file = path.join(root, rel);
    expect(refForFile(type, root, file)).toBe(ref);
    expect(assetPathCandidatesForName(type, root, ref)).toContain(file);
    expect(filesForRef(root, ref)).toContain(file);
  });

  test("every placement type is covered by a sample", () => {
    expect(new Set(samples.map(([type]) => type))).toEqual(
      new Set(
        placementTypes().filter((t) => t !== "session" && t !== "fact" && t !== "command" && t !== "instruction"),
      ),
    );
  });

  test("skills/SKILL.md and skills/x.md sit in the type folder and name no skill", () => {
    const root = path.join(path.sep, "bundle");
    expect(refForFile("skill", root, path.join(root, "skills", "SKILL.md"))).toBeUndefined();
    expect(refForFile("skill", root, path.join(root, "skills", "x.md"))).toBeUndefined();
    expect(refForFile("skill", root, path.join(root, "SKILL.md"))).toBeUndefined();
  });
});

describe("recognition gives a file its path as its ref", () => {
  test("a file under its type folder keeps its ref", () => {
    const file = write("knowledge/auth.md", "# Auth\n");
    expect(akmAdapter.recognize(component(), buildFileContext(storage.stashDir, file))?.conceptId).toBe(
      "knowledge/auth",
    );
  });

  test.each([
    ["tools/agents/foo.md", "tools/agents/foo"],
    ["projects/openpalm/knowledge/auth.md", "projects/openpalm/knowledge/auth"],
    ["reports/data.js", "reports/data.js"],
  ])("%s is %s", (rel, ref) => {
    const file = write(rel, "# Doc\n");
    const document = akmAdapter.recognize(component(), buildFileContext(storage.stashDir, file));
    expect(document?.conceptId).toBe(ref);
    expect(document?.ref).toBe(`akm//${ref}`);
    // The ref inverts to the file.
    expect(resolveAdapterConceptOwner(storage.stashDir, "akm", ref)?.path).toBe(file);
  });
});

describe("the old, type-folder-prefixed spelling of a loose file's ref", () => {
  test("still resolves once the ref itself misses, and warns once that it is outdated", async () => {
    const file = write("reports/x.md", "# Report\n");
    writeSandboxConfig({ semanticSearchMode: "off" });
    resetConfigCache();
    const sources = resolveSourceEntries(undefined, loadConfig());
    const warnings: string[] = [];
    await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level === "warn") warnings.push(args.map(String).join(" "));
      },
      async () => {
        const current = resolveConceptOwner({ conceptId: "reports/x" }, sources);
        expect(current?.owner.path).toBe(file);
        expect(warnings).toEqual([]);
        const old = resolveConceptOwner({ conceptId: "knowledge/reports/x" }, sources);
        expect(old?.owner.path).toBe(file);
        expect(old?.owner.conceptId).toBe("reports/x");
        resolveConceptOwner({ conceptId: "knowledge/reports/x" }, sources);
      },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"knowledge\/reports\/x" is outdated.*"reports\/x"/);
  });

  test("a ref that names nothing under either spelling is still not found", () => {
    write("reports/x.md", "# Report\n");
    writeSandboxConfig({ semanticSearchMode: "off" });
    resetConfigCache();
    const sources = resolveSourceEntries(undefined, loadConfig());
    expect(resolveConceptOwner({ conceptId: "knowledge/reports/missing" }, sources)).toBeUndefined();
  });
});

describe("env and secrets outside their folder", () => {
  function configure(): void {
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "team",
      bundles: { team: { path: storage.stashDir } },
    });
    resetConfigCache();
  }

  test("a secret outside secrets/ is a secret: its token injects the value, qualified or not", () => {
    write("projects/x/secrets/key.pem", "s3cr3t-value\n");
    configure();
    expect(isInstalledBundle("team")).toBe(true);

    const owner = resolveRefOwner("team//projects/x/secrets/key.pem");
    expect(owner?.type).toBe("secret");
    expect(resolveRefToken("team//projects/x/secrets/key.pem")).toEqual({ kind: "secret", value: "s3cr3t-value" });

    const { values, missing, secretValues } = substituteRefTokens(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${ref}` token syntax, not interpolation
      { API_KEY: "${team//projects/x/secrets/key.pem}" },
      resolveRefToken,
      isInstalledBundle,
    );
    expect(values.API_KEY).toBe("s3cr3t-value");
    expect(missing).toEqual([]);
    expect(secretValues).toEqual(["s3cr3t-value"]);
  });

  test("a secret under secrets/ still injects its value, and a non-secret ref still yields a path", () => {
    write("secrets/token", "tok\n");
    const script = write("scripts/run.sh", "echo\n");
    configure();
    expect(resolveRefToken("secrets/token")).toEqual({ kind: "secret", value: "tok" });
    expect(resolveRefToken("scripts/run.sh")).toEqual({ kind: "path", path: script });
  });

  test("a file in a folder named for neither is not a secret", () => {
    const file = write("notes/token.md", "# not a secret\n");
    configure();
    expect(resolveRefToken("team//notes/token")).toEqual({ kind: "path", path: file });
    expect(resolveRefOwner("team//notes/token")?.type).not.toBe("secret");
  });

  test("an env outside env/ resolves by its owning file; a secret ref is refused as an env", () => {
    const loose = write("team/env/staging.env", "A=1\n");
    write("secrets/token", "tok\n");
    configure();
    const found = resolveEnvPath("team//team/env/staging");
    expect(found.absPath).toBe(loose);
    expect(found.conceptId).toBe("team/env/staging");
    expect(() => resolveEnvPath("secrets/token")).toThrow(/Expected an env ref/);
  });
});
