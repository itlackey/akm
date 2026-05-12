/**
 * Tests for per-process agent configuration overrides.
 *
 * Coverage:
 *   - resolveProcessAgentProfile returns default profile when no processes map is set
 *   - String shorthand resolves to named profile
 *   - Object with `profile` resolves to named profile
 *   - Object with `timeoutMs: null` returns undefined timeout (unlimited)
 *   - Object with `timeoutMs: 5000` returns 5000
 *   - Unknown process name falls back to default
 *   - Missing profile name in entry falls back to default
 *   - Invalid entry (unknown keys) is warn-and-ignored
 *   - parseProcessesMap handles mixed string/object entries
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const warnings: string[] = [];

// NOTE: `mock.module` in Bun is process-global — once installed it persists
// across test files run in the same `bun test` invocation. So this mock must
// remain a faithful drop-in for the real `src/core/warn` module.
let mockedQuiet = false;
let mockedVerbose = false;
mock.module("../../src/core/warn", () => ({
  warn: (...args: unknown[]) => {
    warnings.push(args.join(" "));
    if (!mockedQuiet) console.warn(...args);
  },
  warnVerbose: (...args: unknown[]) => {
    if (!mockedVerbose) return;
    warnings.push(args.join(" "));
    if (!mockedQuiet) console.warn(...args);
  },
  setQuiet: (value: boolean) => {
    mockedQuiet = value;
  },
  resetQuiet: () => {
    mockedQuiet = false;
  },
  isQuiet: () => mockedQuiet,
  setVerbose: (value: boolean) => {
    mockedVerbose = value;
  },
  resetVerbose: () => {
    mockedVerbose = false;
  },
  isVerbose: () => {
    const env = process.env.AKM_VERBOSE?.trim().toLowerCase();
    if (env === "1" || env === "true" || env === "yes" || env === "on") return true;
    if (env === "0" || env === "false" || env === "no" || env === "off") return false;
    return mockedVerbose;
  },
}));

beforeEach(() => {
  warnings.length = 0;
  mockedQuiet = true; // suppress console noise during tests
});

afterEach(() => {
  warnings.length = 0;
  mockedQuiet = false;
});

// ── resolveProcessAgentProfile ──────────────────────────────────────────────

describe("resolveProcessAgentProfile", () => {
  test("returns default profile when no processes map set", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = { default: "claude" };
    const { profile, timeoutMs } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(profile.name).toBe("claude");
    expect(timeoutMs).toBeUndefined();
  });

  test("string shorthand resolves to named profile", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = {
      default: "claude",
      processes: { reflect: "opencode" },
    };
    const { profile } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(profile.name).toBe("opencode");
  });

  test("object with profile resolves to named profile", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = {
      default: "claude",
      processes: { reflect: { profile: "codex" } },
    };
    const { profile } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(profile.name).toBe("codex");
  });

  test("object with timeoutMs: null returns undefined timeout (unlimited)", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = {
      default: "claude",
      processes: { reflect: { timeoutMs: null } },
    };
    const { timeoutMs } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(timeoutMs).toBeUndefined();
  });

  test("object with timeoutMs: 5000 returns 5000", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = {
      default: "claude",
      processes: { reflect: { timeoutMs: 5000 } },
    };
    const { timeoutMs } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(timeoutMs).toBe(5000);
  });

  test("unknown process name falls back to default", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = {
      default: "opencode",
      processes: { propose: "claude" },
    };
    // "reflect" is not listed in processes — falls back to default "opencode"
    const { profile } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(profile.name).toBe("opencode");
  });

  test("missing profile name in entry falls back to default", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = {
      default: "codex",
      processes: { reflect: { timeoutMs: 10000 } }, // no profile key
    };
    const { profile, timeoutMs } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(profile.name).toBe("codex"); // fell back to default
    expect(timeoutMs).toBe(10000);
  });

  test("profile-level timeoutMs is used when process entry has none", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = {
      default: "opencode",
      profiles: { opencode: { timeoutMs: 90000 } },
      processes: { reflect: { profile: "opencode" } },
    };
    const { timeoutMs } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(timeoutMs).toBe(90000);
  });

  test("agent-level timeoutMs is used when process and profile both omit it", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = {
      default: "claude",
      timeoutMs: 120000,
      processes: { reflect: "claude" },
    };
    const { timeoutMs } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(timeoutMs).toBe(120000);
  });

  test("process-level timeoutMs beats profile-level and agent-level", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const agentConfig = {
      default: "claude",
      timeoutMs: 120000,
      profiles: { claude: { timeoutMs: 90000 } },
      processes: { reflect: { timeoutMs: 30000 } },
    };
    const { timeoutMs } = resolveProcessAgentProfile("reflect", agentConfig);
    expect(timeoutMs).toBe(30000);
  });

  test("throws ConfigError when agent config is undefined", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const { ConfigError } = await import("../../src/core/errors");
    let caught: unknown;
    try {
      resolveProcessAgentProfile("reflect", undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain("agent commands are disabled");
  });
});

// ── parseProcessEntry ───────────────────────────────────────────────────────

describe("parseProcessEntry", () => {
  test("accepts a string (profile name)", async () => {
    const { parseProcessEntry } = await import("../../src/integrations/agent/config");
    const result = parseProcessEntry("opencode", "reflect");
    expect(result).toBe("opencode");
    expect(warnings).toHaveLength(0);
  });

  test("accepts an object with profile and timeoutMs", async () => {
    const { parseProcessEntry } = await import("../../src/integrations/agent/config");
    const result = parseProcessEntry({ profile: "codex", timeoutMs: 60000 }, "reflect");
    expect(result).toEqual({ profile: "codex", timeoutMs: 60000 });
    expect(warnings).toHaveLength(0);
  });

  test("accepts an object with timeoutMs: null (unlimited)", async () => {
    const { parseProcessEntry } = await import("../../src/integrations/agent/config");
    const result = parseProcessEntry({ timeoutMs: null }, "reflect");
    expect(result).toEqual({ timeoutMs: null });
    expect(warnings).toHaveLength(0);
  });

  test("accepts an empty object (no fields specified)", async () => {
    const { parseProcessEntry } = await import("../../src/integrations/agent/config");
    const result = parseProcessEntry({}, "reflect");
    expect(result).toEqual({});
    expect(warnings).toHaveLength(0);
  });

  test("invalid entry with unknown keys is warn-and-ignored", async () => {
    const { parseProcessEntry } = await import("../../src/integrations/agent/config");
    const result = parseProcessEntry({ unknownKey: "bad", profile: "claude" }, "reflect");
    // The entry is still returned (fields that are valid survive)
    expect(result).toEqual({ profile: "claude" });
    expect(warnings.some((w) => w.includes("unknownKey"))).toBe(true);
  });

  test("invalid string (empty) returns undefined with warning", async () => {
    const { parseProcessEntry } = await import("../../src/integrations/agent/config");
    const result = parseProcessEntry("  ", "reflect");
    expect(result).toBeUndefined();
    expect(warnings.some((w) => w.includes("reflect") && w.includes("non-empty"))).toBe(true);
  });

  test("invalid type (number) returns undefined with warning", async () => {
    const { parseProcessEntry } = await import("../../src/integrations/agent/config");
    const result = parseProcessEntry(42, "reflect");
    expect(result).toBeUndefined();
    expect(warnings.some((w) => w.includes("reflect"))).toBe(true);
  });

  test("invalid type (array) returns undefined with warning", async () => {
    const { parseProcessEntry } = await import("../../src/integrations/agent/config");
    const result = parseProcessEntry(["opencode"], "reflect");
    expect(result).toBeUndefined();
    expect(warnings.some((w) => w.includes("reflect"))).toBe(true);
  });

  test("invalid timeoutMs (non-positive) is warn-and-ignored", async () => {
    const { parseProcessEntry } = await import("../../src/integrations/agent/config");
    const result = parseProcessEntry({ profile: "claude", timeoutMs: -1 }, "reflect");
    // profile is still captured; bad timeoutMs is ignored
    expect(result).toEqual({ profile: "claude" });
    expect(warnings.some((w) => w.includes("timeoutMs"))).toBe(true);
  });
});

// ── parseProcessesMap ───────────────────────────────────────────────────────

describe("parseProcessesMap", () => {
  test("handles mixed string/object entries", async () => {
    const { parseProcessesMap } = await import("../../src/integrations/agent/config");
    const result = parseProcessesMap({
      reflect: "opencode",
      propose: { profile: "claude", timeoutMs: 30000 },
      task: { timeoutMs: null },
    });
    expect(result).toEqual({
      reflect: "opencode",
      propose: { profile: "claude", timeoutMs: 30000 },
      task: { timeoutMs: null },
    });
    expect(warnings).toHaveLength(0);
  });

  test("returns undefined for non-object input", async () => {
    const { parseProcessesMap } = await import("../../src/integrations/agent/config");
    expect(parseProcessesMap("bad")).toBeUndefined();
    expect(warnings.some((w) => w.includes("agent.processes"))).toBe(true);
  });

  test("returns undefined for array input", async () => {
    const { parseProcessesMap } = await import("../../src/integrations/agent/config");
    expect(parseProcessesMap([])).toBeUndefined();
    expect(warnings.some((w) => w.includes("agent.processes"))).toBe(true);
  });

  test("returns undefined when all entries are invalid", async () => {
    const { parseProcessesMap } = await import("../../src/integrations/agent/config");
    const result = parseProcessesMap({ reflect: 42, propose: null });
    expect(result).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("skips invalid entries and keeps valid ones", async () => {
    const { parseProcessesMap } = await import("../../src/integrations/agent/config");
    const result = parseProcessesMap({ reflect: "opencode", propose: 99 });
    expect(result).toEqual({ reflect: "opencode" });
    expect(warnings.some((w) => w.includes("propose"))).toBe(true);
  });

  test("parseAgentConfig round-trips processes map", async () => {
    const { parseAgentConfig } = await import("../../src/integrations/agent/config");
    const parsed = parseAgentConfig({
      default: "claude",
      processes: {
        reflect: "opencode",
        propose: { profile: "claude", timeoutMs: 60000 },
        task: { timeoutMs: null },
      },
    });
    expect(parsed?.processes?.reflect).toBe("opencode");
    expect(parsed?.processes?.propose).toEqual({ profile: "claude", timeoutMs: 60000 });
    expect(parsed?.processes?.task).toEqual({ timeoutMs: null });
    expect(warnings).toHaveLength(0);
  });
});
