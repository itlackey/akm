import { describe, expect, test } from "bun:test";
import type { LaunchdExec, LaunchdFs } from "../src/tasks/backends/launchd";
import { buildPlistXml, LAUNCHD_BACKEND } from "../src/tasks/backends/launchd";
import type { TaskDocument } from "../src/tasks/schema";

function makeTask(schedule: string, id = "ping"): TaskDocument {
  return {
    schemaVersion: 1,
    id,
    schedule,
    enabled: true,
    target: { kind: "workflow", ref: "workflow:noop", params: {} },
    source: { path: `/stash/tasks/${id}.yml` },
  };
}

describe("buildPlistXml", () => {
  test("step minutes -> StartInterval", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm");
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("<string>com.akm.task.ping</string>");
    expect(xml).toContain("<key>StartInterval</key>");
    expect(xml).toContain("<integer>900</integer>");
    expect(xml).toContain("<string>/abs/akm</string>");
    expect(xml).toContain("<string>tasks</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<string>ping</string>");
    expect(xml).toContain("<string>/var/log/akm/ping.log</string>");
  });

  test("daily at HH:MM -> StartCalendarInterval", () => {
    const xml = buildPlistXml(makeTask("30 9 * * *"), ["/abs/akm"], "/var/log/akm");
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain("<key>Hour</key><integer>9</integer>");
    expect(xml).toContain("<key>Minute</key><integer>30</integer>");
  });

  test("weekly on Mon -> Weekday=1", () => {
    const xml = buildPlistXml(makeTask("0 8 * * 1"), ["/abs/akm"], "/var/log/akm");
    expect(xml).toContain("<key>Weekday</key><integer>1</integer>");
  });

  // ── PATH environment injection ───────────────────────────────────────────

  test("pathEnv set: EnvironmentVariables block with correct PATH appears in output", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm", "/usr/local/bin:/usr/bin:/bin");
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<string>/usr/local/bin:/usr/bin:/bin</string>");
  });

  test("pathEnv set with XML-special characters: value is escaped", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm", "/usr/local/bin&special<>bin");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&gt;");
    expect(xml).not.toContain("&special<>bin");
  });

  test("pathEnv absent: EnvironmentVariables does NOT appear in output", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm");
    expect(xml).not.toContain("EnvironmentVariables");
  });

  test("pathEnv undefined explicitly: EnvironmentVariables does NOT appear in output", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm", undefined);
    expect(xml).not.toContain("EnvironmentVariables");
  });
});

// ── LAUNCHD_BACKEND integration with envPath option ──────────────────────────

function makeFakeExec(): LaunchdExec {
  return {
    run(_args: string[]) {
      return { status: 0, stdout: "", stderr: "" };
    },
    uid() {
      return 501;
    },
  };
}

function makeFakeFs(): LaunchdFs & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    writeFile(file: string, content: string) {
      written.set(file, content);
    },
    removeFile(_file: string) {},
    ensureDir(_dir: string) {},
    list(_dir: string) {
      return [];
    },
    exists(_file: string) {
      return true;
    },
  };
}

describe("LAUNCHD_BACKEND — envPath option", () => {
  test("envPath string: plist written to fake fs contains the provided PATH", () => {
    const fakeFs = makeFakeFs();
    const backend = LAUNCHD_BACKEND({
      exec: makeFakeExec(),
      fs: fakeFs,
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: "/custom/bin:/usr/bin:/bin",
    });
    backend.install(makeTask("*/5 * * * *"));
    const entries = [...fakeFs.written.values()];
    expect(entries.length).toBe(1);
    const plist = entries[0];
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/custom/bin:/usr/bin:/bin</string>");
  });

  test("envPath false: plist does NOT contain EnvironmentVariables", () => {
    const fakeFs = makeFakeFs();
    const backend = LAUNCHD_BACKEND({
      exec: makeFakeExec(),
      fs: fakeFs,
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: false,
    });
    backend.install(makeTask("*/5 * * * *"));
    const entries = [...fakeFs.written.values()];
    expect(entries.length).toBe(1);
    const plist = entries[0];
    expect(plist).not.toContain("EnvironmentVariables");
  });

  test("envPath not set: plist contains EnvironmentVariables with process PATH", () => {
    // When envPath is not provided, LAUNCHD_BACKEND captures process.env.PATH.
    // We cannot assert the exact value, but we can verify the block is present
    // as long as process.env.PATH is defined.
    const savedPath = process.env.PATH;
    process.env.PATH = "/injected/bin:/usr/bin";
    try {
      const fakeFs = makeFakeFs();
      const backend = LAUNCHD_BACKEND({
        exec: makeFakeExec(),
        fs: fakeFs,
        agentsDir: "/tmp/agents",
        logDir: "/tmp/logs",
        akmArgv: ["/abs/akm"],
      });
      backend.install(makeTask("*/5 * * * *"));
      const entries = [...fakeFs.written.values()];
      expect(entries.length).toBe(1);
      const plist = entries[0];
      expect(plist).toContain("<key>EnvironmentVariables</key>");
      expect(plist).toContain("<string>/injected/bin:/usr/bin</string>");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
