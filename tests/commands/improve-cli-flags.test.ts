import { describe, expect, test } from "bun:test";
import { renderUsage } from "citty";
import { extractCommand } from "../../src/commands/improve/extract-cli";
import { listEmbeddedTasks } from "../../src/tasks/embedded";
import { parseTaskSourceV4 } from "../../src/tasks/source/task-source-v4";
// These flag-rejection tests run on the in-process harness
// (tests/_helpers/cli.ts): they fail during arg parsing before any DB access,
// so they need no stash and carry no subprocess cost.
//
// The `improve --dry-run` happy path lives in
// tests/integration/improve-cli-flags.test.ts — it executes improve for real
// and needs a fresh subprocess to avoid state.db lock contention with the
// in-process suite (see the header comment there).
import { runCliCapture } from "../_helpers/cli";
import { withTestImproveLlm } from "../_helpers/improve-config";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

describe("standalone extract CLI engine boundary", () => {
  test("rejects --engine with --strategy before resolving either selection", async () => {
    const result = await runCli([
      "proposal",
      "extract",
      "--type",
      "claude",
      "--engine",
      "fast",
      "--strategy",
      "thorough",
    ]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { error: string; code?: string };
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--engine and --strategy are mutually exclusive");
  });

  test("embedded extract task satisfies the live required mode selection", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({ ...withTestImproveLlm({ semanticSearchMode: "off" }) });
      const embedded = listEmbeddedTasks().find((task) => task.id === "extract");
      expect(embedded).toBeDefined();
      if (!embedded) throw new Error("missing embedded extract task");
      const task = parseTaskSourceV4({ filePath: "embedded:extract", yaml: embedded.yaml });
      if (task.target.kind !== "run") throw new Error("embedded extract task must be an exact shell run");
      expect(task.target.run).toBe("akm proposal extract --auto");

      const bare = await runCli(["proposal", "extract"]);
      expect(bare.status).toBe(2);
      expect(JSON.parse(bare.stderr)).toMatchObject({ code: "MISSING_REQUIRED_ARGUMENT" });

      const result = await runCli(["proposal", "extract", "--auto"]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ shape: "extract-auto-result" });
    } finally {
      storage.cleanup();
    }
  });

  test("extract help does not promise an automatic cron fallback", async () => {
    const help = await renderUsage(extractCommand, extractCommand);
    expect(help).not.toContain("*/30");
    expect(help).not.toMatch(/cron fallback|falls back to .*cron/i);
  });
});

describe("improve --run/--since are report-only flags (#944)", () => {
  test("--run with no scope is rejected before any lock/log/index side effect", async () => {
    const result = await runCli(["improve", "--run", "abc123"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { error: string; code?: string };
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--run");
    expect(parsed.error).toContain("akm improve report");
  });

  test("--since with a real scope is rejected the same way", async () => {
    const result = await runCli(["improve", "skill", "--since", "7d"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { error: string; code?: string };
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--since");
    expect(parsed.error).toContain("akm improve report");
  });

  test("--run is not rejected by the report-only-flag guard when the scope is report", async () => {
    const result = await runCli(["improve", "report", "--run", "abc123"]);
    // No improve_runs row exists in this fresh sandbox, so runImproveReportQuery
    // itself fails to find it — that is a different, expected error. What this
    // asserts is narrower: the report-only-flag guard this item adds must not
    // also fire once the scope is actually "report".
    const parsed = JSON.parse(result.stderr || "{}") as { error?: string };
    expect(parsed.error ?? "").not.toContain("only applies to");
  });
});
