import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import { claudeAdapter } from "../../../src/core/adapter/adapters/claude-adapter";
import { opencodeAdapter } from "../../../src/core/adapter/adapters/opencode-adapter";
import type { BundleAdapter } from "../../../src/core/adapter/bundle-adapter";
import {
  executionDefaultsFromFrontmatter,
  parseExecutionMarkdown,
  renderMarkdownExecutionSource,
} from "../../../src/core/adapter/execution-source";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { createResolvedCommand } from "../../../src/execution/resolved-request";
import { createAdapterRenderedExecutionSource } from "../../../src/execution/source";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import {
  assertFixtureBytesUnchanged,
  captureFixtureBytes,
  EXECUTION_CONTRACT_FIXTURES,
  sha256Utf8,
} from "../../_helpers/execution-contracts";

const NATIVE_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "native");

const cases: Array<{
  adapter: BundleAdapter;
  adapterId: "akm" | "claude" | "opencode";
  kind: "command" | "persona";
  file: string;
}> = [
  { adapter: akmAdapter, adapterId: "akm", kind: "command", file: "commands/contract-review.md" },
  { adapter: akmAdapter, adapterId: "akm", kind: "persona", file: "agents/contract-reviewer.md" },
  { adapter: claudeAdapter, adapterId: "claude", kind: "command", file: "commands/contract-review.md" },
  { adapter: claudeAdapter, adapterId: "claude", kind: "persona", file: "agents/contract-reviewer.md" },
  { adapter: opencodeAdapter, adapterId: "opencode", kind: "command", file: "commands/contract-review.md" },
  { adapter: opencodeAdapter, adapterId: "opencode", kind: "persona", file: "agents/contract-reviewer.md" },
];

function render(testCase: (typeof cases)[number]) {
  const root = path.join(NATIVE_ROOT, testCase.adapterId);
  const component: BundleComponent = {
    id: `fixture-${testCase.adapterId}`,
    adapter: testCase.adapterId,
    root,
    writable: false,
  };
  const file = buildFileContext(root, path.join(root, testCase.file));
  const source = testCase.adapter.renderExecutionSource?.(component, file);
  if (!source) throw new Error(`${testCase.adapterId}:${testCase.file} did not render an execution source`);
  return { root, file, source };
}

function renderCase(adapterId: (typeof cases)[number]["adapterId"], kind: (typeof cases)[number]["kind"]) {
  const testCase = cases.find((candidate) => candidate.adapterId === adapterId && candidate.kind === kind);
  if (!testCase) throw new Error(`missing execution source case: ${adapterId}:${kind}`);
  return render(testCase).source;
}

describe("adapter-rendered execution sources", () => {
  test("AKM, Claude, and OpenCode return body-only command/persona records with exact identity", () => {
    const before = captureFixtureBytes(NATIVE_ROOT);
    for (const testCase of cases) {
      const { file, source } = render(testCase);
      const raw = fs.readFileSync(file.absPath, "utf8");
      const conceptId = testCase.file.replace(/\.md$/, "");

      expect(source.kind, `${testCase.adapterId}:${testCase.file}`).toBe(testCase.kind);
      expect(source.content).toContain("# Contract review");
      expect(source.content).not.toStartWith("---");
      expect(source.content).not.toContain("description:");
      expect(source.identity).toEqual({
        ref: `fixture-${testCase.adapterId}//${conceptId}`,
        bundle: `fixture-${testCase.adapterId}`,
        adapter: testCase.adapterId,
        file: testCase.file,
        hash: sha256Utf8(raw),
      });
      expect(Object.hasOwn(source, "raw")).toBe(false);
      expect(Object.hasOwn(source, "frontmatter")).toBe(false);
    }
    assertFixtureBytesUnchanged(NATIVE_ROOT, before);
  });

  test("translates common defaults and retains only explicit owner-keyed native extensions", () => {
    const akmCommand = renderCase("akm", "command");
    const akmPersona = renderCase("akm", "persona");
    const claudeCommand = renderCase("claude", "command");
    const claudePersona = renderCase("claude", "persona");
    const opencodeCommand = renderCase("opencode", "command");
    const opencodePersona = renderCase("opencode", "persona");

    expect(akmCommand.defaults).toEqual({ agent: "agents/contract-reviewer", model: "fixture-balanced" });
    expect(akmPersona.defaults).toEqual({ model: "fixture-balanced", tools: ["read", "grep"] });
    expect(claudeCommand.defaults).toEqual({
      engine: "fixture-agent",
      model: "fixture-balanced",
      tools: "Read, Grep",
      timeout: "45s",
    });
    expect(claudeCommand.extensions).toEqual({ claude: { argumentHint: "<target>" } });
    expect(claudePersona.defaults).toEqual({
      engine: "fixture-agent",
      model: "fixture-balanced",
      tools: "Read, Grep",
      timeout: "45s",
    });
    expect(opencodeCommand.defaults).toEqual({
      agent: "contract-reviewer",
      model: "fixture-balanced",
      tools: { read: true, grep: true },
    });
    expect(opencodePersona.defaults).toEqual({
      engine: "fixture-agent",
      model: "fixture-balanced",
      inference: { temperature: 0 },
      tools: { read: true, grep: true, write: false },
      timeout: "45s",
    });
    expect(opencodePersona.extensions).toEqual({ opencode: { mode: "subagent" } });
  });

  test("construction rejects an unrendered structural lookalike", () => {
    const rawLookalike = {
      kind: "command",
      content: "---\ndescription: leaked frontmatter\n---\nDo work.",
      defaults: {},
      identity: {
        ref: "fixture//commands/raw",
        bundle: "fixture",
        adapter: "akm",
        file: "commands/raw.md",
        hash: "0".repeat(64),
      },
    };
    expect(() => createResolvedCommand({ source: rawLookalike as never, content: rawLookalike.content })).toThrow(
      /adapter-rendered command source/i,
    );

    expect(() =>
      renderMarkdownExecutionSource({
        kind: "command",
        raw: "---\ndescription: unterminated\nDo work.",
        identity: {
          ref: "fixture//commands/unterminated",
          bundle: "fixture",
          adapter: "akm",
          file: "commands/unterminated.md",
        },
      }),
    ).toThrow(/frontmatter/i);
  });

  test("requires an own brand, exact prototype, and frozen source object", () => {
    const valid = renderCase("akm", "command");
    const inherited = Object.create(valid) as typeof valid;
    const overridden = Object.create(valid, {
      content: { value: "---\nraw: leaked\n---\nDo the wrong work.", enumerable: true },
      raw: { value: "native bytes", enumerable: true },
      frontmatter: { value: { model: "attacker/model" }, enumerable: true },
    }) as typeof valid;

    expect(() => createResolvedCommand({ source: inherited as never, content: inherited.content })).toThrow(
      /adapter-rendered command source/i,
    );
    expect(() => createResolvedCommand({ source: overridden as never, content: overridden.content })).toThrow(
      /adapter-rendered command source/i,
    );
    expect(Object.isFrozen(valid)).toBe(true);
    expect(Object.getPrototypeOf(valid)).toBe(Object.prototype);

    const strictRaw = "---\nmodel: provider/exact\n---\nDo work.\n";
    expect(() =>
      renderMarkdownExecutionSource({
        kind: "command",
        raw: strictRaw,
        identity: {
          ref: "fixture//commands/strict-keys",
          bundle: "fixture",
          adapter: "akm",
          file: "commands/strict-keys.md",
          extra: true,
        },
      } as never),
    ).toThrow(/identity.*extra|extra/i);
    expect(() =>
      renderMarkdownExecutionSource({
        kind: "command",
        raw: strictRaw,
        identity: {
          ref: "fixture//commands/strict-keys",
          bundle: "fixture",
          adapter: "akm",
          file: "commands/strict-keys.md",
        },
        extra: true,
      } as never),
    ).toThrow(/source.*extra|extra/i);
  });

  test("does not authorize a source by a reflected construction symbol", () => {
    const valid = renderCase("akm", "command");
    const [sourceBrand] = Object.getOwnPropertySymbols(valid);
    if (!sourceBrand) throw new Error("adapter source brand is missing");
    const forged = {
      schemaVersion: valid.schemaVersion,
      kind: valid.kind,
      content: "---\nraw: leaked\n---\nDo the wrong work.",
      defaults: valid.defaults,
      identity: valid.identity,
    };
    Object.defineProperty(forged, sourceBrand, { value: true, enumerable: false });
    Object.freeze(forged);

    expect(() => createResolvedCommand({ source: forged as never, content: forged.content })).toThrow(
      /adapter-rendered command source/i,
    );
  });

  test("rejects accessor-backed raw and rendered content before inconsistent reads", () => {
    let rawReads = 0;
    const rawInput = {
      kind: "command" as const,
      identity: {
        ref: "fixture//commands/raw-getter",
        bundle: "fixture",
        adapter: "akm",
        file: "commands/raw-getter.md",
      },
    } as Record<string, unknown>;
    Object.defineProperty(rawInput, "raw", {
      enumerable: true,
      get: () => {
        rawReads += 1;
        return rawReads === 1 ? "Safe body.\n" : "---\nraw: leaked\n---\nWrong body.\n";
      },
    });
    expect(() => renderMarkdownExecutionSource(rawInput as never)).toThrow(/raw|accessor|data propert/i);
    expect(rawReads).toBe(0);

    let contentReads = 0;
    const contentInput = {
      kind: "command" as const,
      identity: {
        ref: "fixture//commands/content-getter",
        bundle: "fixture",
        adapter: "akm",
        file: "commands/content-getter.md",
        hash: "a".repeat(64),
      },
    } as Record<string, unknown>;
    Object.defineProperty(contentInput, "content", {
      enumerable: true,
      get: () => {
        contentReads += 1;
        return contentReads === 1 ? "Safe body.\n" : "---\nfrontmatter: leaked\n---\nWrong body.\n";
      },
    });
    expect(() => createAdapterRenderedExecutionSource(contentInput as never)).toThrow(/content|accessor|data propert/i);
    expect(contentReads).toBe(0);
  });

  test("strict execution frontmatter handles BOM/CRLF and hashes the exact original text", () => {
    const raw = "\uFEFF---\r\nmodel: provider/exact\r\ntemperature: 0\r\n---\r\nDo work.\r\n";
    const source = renderMarkdownExecutionSource({
      kind: "command",
      raw,
      identity: {
        ref: "fixture//commands/crlf",
        bundle: "fixture",
        adapter: "akm",
        file: "commands/crlf.md",
      },
      defaults: (data) => ({ model: data.model as string, inference: { temperature: data.temperature as number } }),
    });

    expect(source.content).toBe("Do work.\r\n");
    expect(source.identity.hash).toBe(sha256Utf8(raw));
    expect(source.defaults).toEqual({ model: "provider/exact", inference: { temperature: 0 } });

    const bodyOnlyRaw = "\uFEFFDo work without metadata.\r\n";
    const bodyOnly = renderMarkdownExecutionSource({
      kind: "command",
      raw: bodyOnlyRaw,
      identity: {
        ref: "fixture//commands/body-only-bom",
        bundle: "fixture",
        adapter: "akm",
        file: "commands/body-only-bom.md",
      },
    });
    expect(bodyOnly.content).toBe("Do work without metadata.\r\n");
    expect(bodyOnly.identity.hash).toBe(sha256Utf8(bodyOnlyRaw));
  });

  test("clones renderer identity and defaults before caller mutation", () => {
    const identity = {
      ref: "fixture//commands/cloned",
      bundle: "fixture",
      adapter: "akm",
      file: "commands/cloned.md",
    };
    const defaults = { model: "provider/before", inference: { temperature: 0 } };
    const source = renderMarkdownExecutionSource({
      kind: "command",
      raw: "Do work.\n",
      identity,
      defaults,
    });

    identity.file = "commands/mutated.md";
    defaults.model = "provider/after";
    defaults.inference.temperature = 1;
    expect(source.identity.file).toBe("commands/cloned.md");
    expect(source.defaults).toEqual({ model: "provider/before", inference: { temperature: 0 } });
  });

  test("strict execution frontmatter preserves body-only files and rejects malformed fenced metadata", () => {
    const renderRaw = (raw: string) =>
      renderMarkdownExecutionSource({
        kind: "command",
        raw,
        identity: {
          ref: "fixture//commands/strict",
          bundle: "fixture",
          adapter: "akm",
          file: "commands/strict.md",
        },
      });

    expect(renderRaw("Do work without metadata.\n").content).toBe("Do work without metadata.\n");
    expect(() => renderRaw("---\nmodel: one\nDo work.\n")).toThrow(/unterminated.*frontmatter/i);
    expect(() => renderRaw("---\nmodel: [one,\n---\nDo work.\n")).toThrow(/invalid.*YAML|YAML.*error/i);
    expect(() => renderRaw("---\n- model\n- one\n---\nDo work.\n")).toThrow(/mapping/i);
    expect(() => renderRaw("---\nmodel: one\nmodel: two\n---\nDo work.\n")).toThrow(/duplicate|YAML/i);
  });

  test("warns (does not throw) on a frontmatter anchor with no alias reference, and an explicit tag, and still parses", () => {
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const anchored = parseExecutionMarkdown("---\nmodel: &chosen one\n---\nDo work.\n", "commands/anchored.md");
      expect(anchored.data.model).toBe("one");
      expect(warnings.some((w) => w.includes("commands/anchored.md") && /anchor/i.test(w))).toBe(true);

      const tagged = parseExecutionMarkdown("---\nmodel: !engine one\n---\nDo work.\n", "commands/tagged.md");
      expect(tagged.data.model).toBe("one");
      expect(warnings.some((w) => w.includes("commands/tagged.md") && /tag/i.test(w))).toBe(true);
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });

  test("an alias reference still fails via toJS's own maxAliasCount bound, now as a UsageError naming the file", () => {
    expect(() =>
      parseExecutionMarkdown("---\nmodel: &chosen one\nengine: *chosen\n---\nDo work.\n", "commands/aliased.md"),
    ).toThrow(/commands\/aliased\.md.*alias/is);
  });

  test("rejects wrong recognized metadata types and preserves explicit null inference", () => {
    const renderDefaults = (metadata: string, kind: "command" | "persona" = "command") =>
      renderMarkdownExecutionSource({
        kind,
        raw: `---\n${metadata}\n---\nDo work.\n`,
        identity: {
          ref: `fixture//${kind === "command" ? "commands" : "agents"}/typed-metadata`,
          bundle: "fixture",
          adapter: "akm",
          file: `${kind === "command" ? "commands" : "agents"}/typed-metadata.md`,
        },
        defaults: (data) => executionDefaultsFromFrontmatter(data, { kind, allowTopLevelEngine: true }),
      });

    expect(() => renderDefaults("model: false")).toThrow(/frontmatter\.model|model.*string/i);
    expect(() => renderDefaults("agent: {}")).toThrow(/frontmatter\.agent|agent.*string/i);
    expect(() => renderDefaults("akm: scalar", "persona")).toThrow(/frontmatter\.akm|akm.*mapping/i);
    expect(() => renderDefaults("akm:\n  inference: false", "persona")).toThrow(
      /frontmatter\.akm\.inference|inference.*object/i,
    );
    expect(renderDefaults("akm:\n  inference: null", "persona").defaults.inference).toBeNull();
    expect(renderDefaults("akm:\n  inference: {}", "persona").defaults).toEqual({ inference: {} });
    expect(() => renderDefaults("temperature: false", "persona")).toThrow(/frontmatter\.temperature|number/i);
    expect(() => renderDefaults("effort: {}", "persona")).toThrow(/frontmatter\.effort|string/i);
    expect(() => renderDefaults("engine: selected\nakm:\n  engine: false", "persona")).toThrow(
      /frontmatter\.akm\.engine|engine.*string/i,
    );
    expect(() => renderDefaults("schema: {}\nakm:\n  schema: false", "persona")).toThrow(
      /frontmatter\.akm\.schema|schema.*object/i,
    );
    expect(() => renderDefaults("timeoutMs: 1\nakm:\n  timeout: []", "persona")).toThrow(
      /frontmatter\.akm\.timeout|timeout.*string.*number/i,
    );
    expect(() => renderDefaults("workspace: here\nakm:\n  environment: false", "persona")).toThrow(
      /frontmatter\.workspace.*host-controlled/i,
    );
  });

  test("rejects wrong types for recognized adapter-owned native metadata", () => {
    const renderNative = (adapter: BundleAdapter, adapterId: "claude" | "opencode", raw: string) => {
      const root = path.join(NATIVE_ROOT, adapterId);
      const component: BundleComponent = {
        id: `fixture-${adapterId}`,
        adapter: adapterId,
        root,
        writable: false,
      };
      const file = buildFileContext(root, path.join(root, "commands/contract-review.md"));
      return adapter.renderExecutionSource?.(component, {
        ...file,
        content: () => raw,
      });
    };

    expect(() => renderNative(claudeAdapter, "claude", "---\nargument-hint: false\n---\nDo work.\n")).toThrow(
      /argument-hint.*string/i,
    );
    expect(() =>
      renderNative(claudeAdapter, "claude", "---\nallowed-tools: Read\ntools: false\n---\nDo work.\n"),
    ).toThrow(/frontmatter\.tools|tools/i);
    expect(() => renderNative(opencodeAdapter, "opencode", "---\nmode: false\n---\nDo work.\n")).toThrow(
      /mode.*string/i,
    );
  });

  test("does not merge untrusted inference keys through a mutable plain-object prototype", () => {
    const source = renderMarkdownExecutionSource({
      kind: "persona",
      raw: `---
akm:
  inference:
    __proto__:
      polluted: true
    constructor:
      prototype:
        polluted: true
temperature: 0
---
Review safely.
`,
      identity: {
        ref: "fixture//agents/safe-inference",
        bundle: "fixture",
        adapter: "akm",
        file: "agents/safe-inference.md",
      },
      defaults: (data) =>
        executionDefaultsFromFrontmatter(data, {
          kind: "persona",
          allowTopLevelEngine: true,
        }),
    });

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    const inference = source.defaults.inference;
    expect(inference?.temperature).toBe(0);
    expect(Object.hasOwn(inference ?? {}, "__proto__")).toBe(true);
    expect(inference?.["__proto__"]).toEqual({ polluted: true });
    expect(inference?.["constructor"]).toEqual({ prototype: { polluted: true } });
  });
});
