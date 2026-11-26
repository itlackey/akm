import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { untaggedMemoriesFirst } from "../../../../src/commands/improve/memory-enrichment";
import { selectProactiveMaintenanceRefs } from "../../../../src/commands/improve/proactive-maintenance";
import type { AkmConfig } from "../../../../src/core/config/config";
import type { ImproveEligibleRef } from "../../../../src/core/improve-types";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const NOW = Date.parse("2026-06-14T00:00:00.000Z");

describe("untaggedMemoriesFirst", () => {
  const on = { experimental: { memoryEnrichment: true } } as AkmConfig;
  const isUntaggedMemory = untaggedMemoriesFirst(on) as (ref: ImproveEligibleRef) => boolean;
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());
  const entry = (name: string, text: string, type = "memory"): ImproveEligibleRef => {
    fs.writeFileSync(path.join(storage.stashDir, "memories", `${name}.md`), text);
    return { ref: `memories/${name}`, type, reason: "scope-type" };
  };

  test("selectProactiveMaintenanceRefs plans untagged memories first only with the setting on", () => {
    const candidates = [
      entry("tagged", "---\ntags: [ops]\n---\n\nbody\n"),
      entry("untagged", "---\ndescription: d\n---\n\nbody\n"),
    ];
    const params = {
      candidates,
      lastReflectTs: new Map<string, string>(),
      lastDistillTs: new Map<string, string>(),
      retrievalCounts: new Map([
        ["memories/tagged", 50],
        ["memories/untagged", 0],
      ]),
      now: NOW,
    };
    expect(selectProactiveMaintenanceRefs(params).selected[0]?.ref).toBe("memories/tagged");
    expect(selectProactiveMaintenanceRefs({ ...params, config: on }).selected[0]?.ref).toBe("memories/untagged");
    expect(
      selectProactiveMaintenanceRefs({ ...params, config: { experimental: { memoryEnrichment: false } } as AkmConfig })
        .selected[0]?.ref,
    ).toBe("memories/tagged");
  });

  test("is nothing unless the setting is on", () => {
    expect(untaggedMemoriesFirst({} as AkmConfig)).toBeUndefined();
    expect(untaggedMemoriesFirst({ experimental: { memoryEnrichment: false } } as AkmConfig)).toBeUndefined();
  });

  test("a memory with no tags, or an empty list, is untagged", () => {
    expect(isUntaggedMemory(entry("none", "---\ndescription: d\n---\n\nbody\n"))).toBe(true);
    expect(isUntaggedMemory(entry("empty", "---\ntags: []\n---\n\nbody\n"))).toBe(true);
  });

  test("a tagged memory, another type, or a missing asset is not", () => {
    expect(isUntaggedMemory(entry("tagged", "---\ntags: [ops]\n---\n\nbody\n"))).toBe(false);
    expect(isUntaggedMemory(entry("other", "body\n", "skill"))).toBe(false);
    expect(isUntaggedMemory({ ref: "memories/gone", type: "memory", reason: "scope-type" })).toBe(false);
  });
});
