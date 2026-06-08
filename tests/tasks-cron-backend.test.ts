import { describe, expect, test } from "bun:test";
import {
  buildCronLine,
  CRON_BACKEND,
  type CronExec,
  type CronExecResult,
  cronBlockBody,
  listBlocks,
  removeBlock,
  renderBlock,
  toggleBlock,
  upsertBlock,
} from "../src/tasks/backends/cron";
import type { TaskDocument } from "../src/tasks/schema";

const TASK: TaskDocument = {
  schemaVersion: 1,
  id: "ping",
  schedule: "*/15 * * * *",
  enabled: true,
  target: { kind: "workflow", ref: "workflow:noop", params: {} },
  source: { path: "/stash/tasks/ping.yml" },
};

describe("cron backend helpers", () => {
  test("buildCronLine emits absolute akm path", () => {
    const line = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm");
    expect(line).toBe("*/15 * * * * /usr/local/bin/akm tasks run ping >> /var/log/akm/ping.log 2>&1");
  });

  test("buildCronLine quotes paths containing spaces", () => {
    const line = buildCronLine(TASK, ["/Applications/My Stuff/akm"], "/var/log");
    expect(line).toContain("'/Applications/My Stuff/akm'");
  });

  test("buildCronLine escapes apostrophes for POSIX shell", () => {
    const line = buildCronLine(TASK, ["/opt/akm's/bin/akm"], "/var/log/akm's");
    expect(line).toContain("'/opt/akm'\\''s/bin/akm'");
    expect(line).toContain("'/var/log/akm'\\''s/ping.log'");
  });

  test("renderBlock wraps the cron line in begin/end markers", () => {
    const block = renderBlock("ping", "* * * * * /bin/akm tasks run ping", true);
    expect(block.split("\n")).toEqual([
      "# akm:task ping BEGIN",
      "* * * * * /bin/akm tasks run ping",
      "# akm:task ping END",
    ]);
  });

  test("renderBlock with enabled=false comments the cron line", () => {
    const block = renderBlock("ping", "* * * * * /bin/akm tasks run ping", false);
    const middle = block.split("\n")[1];
    expect(middle.startsWith("# akm:disabled ")).toBe(true);
  });

  test("upsertBlock inserts when absent", () => {
    const next = upsertBlock("# user line\n0 * * * * other-job\n", "ping", renderBlock("ping", "X", true));
    expect(next).toContain("# user line");
    expect(next).toContain("0 * * * * other-job");
    expect(next).toContain("# akm:task ping BEGIN");
    expect(next).toContain("# akm:task ping END");
  });

  test("upsertBlock replaces when present, leaves other lines untouched", () => {
    const initial = [
      "# user line",
      "0 * * * * other-job",
      "# akm:task ping BEGIN",
      "* * * * * old-cmd",
      "# akm:task ping END",
      "# trailing user line",
    ].join("\n");
    const next = upsertBlock(initial, "ping", renderBlock("ping", "* * * * * NEW", true));
    expect(next).toContain("0 * * * * other-job");
    expect(next).toContain("# trailing user line");
    expect(next).toContain("* * * * * NEW");
    expect(next).not.toContain("old-cmd");
  });

  test("removeBlock leaves untouched when block absent", () => {
    const initial = "0 * * * * other-job";
    expect(removeBlock(initial, "ping")).toBe(initial);
  });

  test("removeBlock removes only the named block", () => {
    const initial = [
      "0 * * * * other-job",
      "# akm:task other BEGIN",
      "0 0 * * * /bin/akm tasks run other",
      "# akm:task other END",
      "# akm:task ping BEGIN",
      "* * * * * /bin/akm tasks run ping",
      "# akm:task ping END",
    ].join("\n");
    const next = removeBlock(initial, "ping");
    expect(next).toContain("# akm:task other BEGIN");
    expect(next).not.toContain("# akm:task ping BEGIN");
    expect(next).toContain("0 * * * * other-job");
  });

  test("toggleBlock comments and uncomments the body", () => {
    const enabled = renderBlock("ping", "* * * * * X", true);
    const disabled = toggleBlock(enabled, "ping", false);
    expect(disabled).toContain("# akm:disabled * * * * * X");
    const reenabled = toggleBlock(disabled, "ping", true);
    expect(reenabled).toContain("* * * * * X");
    expect(reenabled).not.toContain("akm:disabled");
  });

  test("cronBlockBody comments only when disabled", () => {
    expect(cronBlockBody("* * * * * X", true)).toBe("* * * * * X");
    expect(cronBlockBody("* * * * * X", false)).toBe("# akm:disabled * * * * * X");
  });

  test("listBlocks parses id and body between markers", () => {
    const crontab = [
      "# user line",
      "# akm:task ping BEGIN",
      "*/15 * * * * /bin/akm tasks run ping",
      "# akm:task ping END",
      "# akm:task other BEGIN",
      "# akm:disabled 0 2 * * * /bin/akm tasks run other",
      "# akm:task other END",
    ].join("\n");
    expect(listBlocks(crontab)).toEqual([
      { id: "ping", body: "*/15 * * * * /bin/akm tasks run ping" },
      { id: "other", body: "# akm:disabled 0 2 * * * /bin/akm tasks run other" },
    ]);
  });
});

// ── drift detection (the `tasks sync` schedule-change fix) ───────────────────

/** In-memory crontab so the backend never touches the real one. */
function memoryExec(initial = ""): CronExec & { current: () => string } {
  let store = initial;
  return {
    read(): CronExecResult {
      return { status: 0, stdout: store, stderr: "" };
    },
    write(content: string): CronExecResult {
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
  };
}

const SYNC_TASK: TaskDocument = {
  schemaVersion: 1,
  id: "ping",
  schedule: "*/15 * * * *",
  enabled: true,
  target: { kind: "workflow", ref: "workflow:noop", params: {} },
  source: { path: "/stash/tasks/ping.yml" },
};

describe("cron backend drift detection", () => {
  const opts = (exec: CronExec) => ({ exec, logDir: "/var/log/akm", akmArgv: ["/usr/local/bin/akm"] });

  test("list() returns a signature equal to expectedSignature for an installed task", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const listed = backend.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe("ping");
    expect(listed[0].signature).toBe(backend.expectedSignature?.(SYNC_TASK));
  });

  test("expectedSignature changes when the schedule changes (drift is detectable)", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const installedSig = backend.list()[0].signature;
    const rescheduled: TaskDocument = { ...SYNC_TASK, schedule: "45 */6 * * *" };
    expect(backend.expectedSignature?.(rescheduled)).not.toBe(installedSig);
  });

  test("expectedSignature changes when enabled flips", () => {
    const backend = CRON_BACKEND(opts(memoryExec()));
    const enabledSig = backend.expectedSignature?.({ ...SYNC_TASK, enabled: true });
    const disabledSig = backend.expectedSignature?.({ ...SYNC_TASK, enabled: false });
    expect(enabledSig).not.toBe(disabledSig);
  });

  test("signature is stable across reinstall when nothing changed", () => {
    const backend = CRON_BACKEND(opts(memoryExec()));
    backend.install(SYNC_TASK);
    const sig1 = backend.list()[0].signature;
    backend.install(SYNC_TASK);
    const sig2 = backend.list()[0].signature;
    expect(sig1).toBe(sig2);
    expect(sig1).toBe(backend.expectedSignature?.(SYNC_TASK));
  });
});
