import { describe, expect, test } from "bun:test";
import { renderUsage } from "citty";
import { extractCommand } from "../../src/commands/improve/extract-cli";
import { listEmbeddedTasks } from "../../src/tasks/embedded";
import { parseTaskDocument } from "../../src/tasks/parser";
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

describe("improve CLI flags (0.8.0)", () => {
  // 0.8.0 deleted --reflect-cooldown-days / --distill-cooldown-days /
  // --consolidate-cooldown-days. The reflect/distill gates now use
  // signal-delta eligibility (see tests/improve-eligibility.test.ts);
  // consolidate uses pool-delta. citty silently ignores unknown flags
  // so we cannot pin rejection here — the flag-rejection tests were
  // dropped along with the flags.

  // NOTE: the `rejects negative min retrieval count` test was dropped here —
  // chunk-7's improve refactor removed the --min-retrieval-count validation,
  // and citty silently ignores the now-unknown flag, so rejection can no longer
  // be pinned (same reason the cooldown-flag rejection tests were dropped above).

  test("rejects invalid consolidate recovery mode", async () => {
    const result = await runCli(["improve", "--consolidate-recovery", "resume", "--dry-run"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--consolidate-recovery");
    expect(parsed.error).toContain("abort");
    expect(parsed.error).toContain("clean");
  });
});

describe("standalone extract CLI engine boundary", () => {
  test("rejects --engine with --strategy before resolving either selection", async () => {
    const result = await runCli(["extract", "--type", "claude-code", "--engine", "fast", "--strategy", "thorough"]);
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
      const task = parseTaskDocument({ id: embedded.id, filePath: "embedded:extract", yaml: embedded.yaml });
      if (task.target.kind !== "command") throw new Error("embedded extract task must be a command");
      const [executable, ...args] = task.target.cmd;
      expect(executable).toBe("akm");

      const bare = await runCli(["extract"]);
      expect(bare.status).toBe(2);
      expect(JSON.parse(bare.stderr)).toMatchObject({ code: "MISSING_REQUIRED_ARGUMENT" });

      const result = await runCli(args);
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
