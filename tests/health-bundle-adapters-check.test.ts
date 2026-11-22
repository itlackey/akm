import { describe, expect, test } from "bun:test";
import { collectBundleAdaptersCheck } from "../src/commands/health/bundle-adapters-check";
import { HEALTH_CHECKS } from "../src/commands/health/checks";
import type { AkmConfig } from "../src/core/config/config";

// `bundle-adapters` reports a configured bundle that names an adapter akm does not have.

function configWith(adapter: string | undefined): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    bundles: { docs: { path: "/tmp/docs", ...(adapter ? { adapter } : {}) } },
  };
}

describe("bundle-adapters check", () => {
  test("is registered as a hard check", () => {
    expect(HEALTH_CHECKS.find((c) => c.name === "bundle-adapters")?.channel).toBe("hard");
  });

  test("passes when every configured adapter is one akm has, or none is configured", () => {
    expect(collectBundleAdaptersCheck(() => configWith("okf"))).toMatchObject({
      name: "bundle-adapters",
      status: "pass",
    });
    expect(collectBundleAdaptersCheck(() => configWith(undefined)).status).toBe("pass");
  });

  test("fails naming the bundle, the adapter and the valid ids", () => {
    const result = collectBundleAdaptersCheck(() => configWith("agent_skills"));
    expect(result.status).toBe("fail");
    expect(result.message).toContain('Bundle "docs" names adapter "agent_skills", which akm does not have.');
    expect(result.message).toContain("agent-skills");
  });

  test("is unknown, blocked, when the config cannot be read", () => {
    const result = collectBundleAdaptersCheck(() => {
      throw new Error("boom");
    });
    expect(result).toMatchObject({ status: "unknown", reason: "blocked" });
    expect(result.message).toContain("boom");
  });
});
