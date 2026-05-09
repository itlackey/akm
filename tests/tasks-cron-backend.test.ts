import { describe, expect, test } from "bun:test";
import { buildCronLine, removeBlock, renderBlock, toggleBlock, upsertBlock } from "../src/tasks/backends/cron";
import type { TaskDocument } from "../src/tasks/schema";

const TASK: TaskDocument = {
  schemaVersion: 1,
  id: "ping",
  schedule: "*/15 * * * *",
  enabled: true,
  target: { kind: "workflow", ref: "workflow:noop", params: {} },
  source: { path: "/stash/tasks/ping.md" },
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
});
