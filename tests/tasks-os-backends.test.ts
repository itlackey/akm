// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The three OS backends under one contract: write the one dispatch entry,
 * read it back, remove akm 0.9's per-task rows in the same operation. Each runs
 * against injected exec/fs fakes; nothing reaches a real crontab, launchctl or
 * schtasks.
 */

import { describe, expect, test } from "bun:test";
import { CRON_BACKEND, type CronExec, type CronExecResult, renderEntryBlock } from "../src/tasks/backends/cron";
import { decodeCommandOutput } from "../src/tasks/backends/exec-utils";
import { buildPlistXml, LAUNCHD_BACKEND, type LaunchdExec, type LaunchdFs } from "../src/tasks/backends/launchd";
import { buildSchtasksXml, SCHTASKS_BACKEND, type SchtasksExec, type SchtasksFs } from "../src/tasks/backends/schtasks";
import { legacyCronBlock, legacyCrontab } from "./_helpers/legacy-scheduler";

const LAUNCHER = ["/usr/local/bin/akm"];
const LOG_DIR = "/home/u/.cache/akm/tasks/logs";

// ── cron ────────────────────────────────────────────────────────────────────

function memoryCron(initial = ""): CronExec & { current: () => string; writes: string[]; failNextWrite: () => void } {
  let store = initial;
  let fail = false;
  const writes: string[] = [];
  return {
    read: (): CronExecResult => ({ status: 0, stdout: store, stderr: "" }),
    write(content: string): CronExecResult {
      if (fail) {
        fail = false;
        return { status: 1, stdout: "", stderr: "disk full" };
      }
      store = content;
      writes.push(content);
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
    writes,
    failNextWrite: () => {
      fail = true;
    },
  };
}

const cron = (
  exec: CronExec,
  extra: { readFile?: (file: string) => string; removeFile?: (file: string) => void } = {},
) => CRON_BACKEND({ exec, logDir: LOG_DIR, ensureDir: () => {}, ...extra });

/** `apply` may throw synchronously or reject: both are a failure. */
const settle = (fn: () => unknown) => Promise.resolve().then(fn);

const entryCount = (crontab: string) => (crontab.match(/^# akm:dispatch BEGIN$/gm) ?? []).length;

describe("cron backend", () => {
  test("the block is one PATH line and one every-minute line that truncates its log", () => {
    expect(renderEntryBlock({ launcher: LAUNCHER, path: "/usr/bin:/bin:/usr/bin" }, LOG_DIR)).toBe(
      [
        "# akm:dispatch BEGIN",
        "PATH=/usr/bin:/bin",
        `* * * * * /usr/local/bin/akm task dispatch > ${LOG_DIR}/dispatch.log 2>&1`,
        "# akm:dispatch END",
      ].join("\n"),
    );
  });

  test("installs on an empty crontab and reads back the same launcher and PATH", async () => {
    const exec = memoryCron();
    const backend = cron(exec);

    await backend.apply({
      entry: { launcher: ["/opt/my bin/node", "/opt/100%/akm"], path: "/usr/bin:/bin" },
      removeLegacy: [],
    });

    expect(entryCount(exec.current())).toBe(1);
    expect(exec.current()).toContain("%");
    expect(await backend.inspect()).toEqual({
      entry: { launcher: ["/opt/my bin/node", "/opt/100%/akm"], path: "/usr/bin:/bin" },
      legacy: [],
    });
  });

  test("applying the same entry again writes the same crontab", async () => {
    const exec = memoryCron("MAILTO=me@example.test\n0 3 * * * /usr/local/bin/mine\n");
    const backend = cron(exec);
    const entry = { launcher: LAUNCHER, path: "/usr/bin" };

    await backend.apply({ entry, removeLegacy: [] });
    const first = exec.current();
    await backend.apply({ entry, removeLegacy: [] });

    expect(exec.current()).toBe(first);
    expect(first.startsWith("MAILTO=me@example.test\n0 3 * * * /usr/local/bin/mine\n")).toBe(true);
    expect(first.trimEnd().endsWith("# akm:dispatch END")).toBe(true);
  });

  test("a changed entry replaces the block in place; null removes it and leaves the user's lines", async () => {
    const exec = memoryCron("0 3 * * * /usr/local/bin/mine\n");
    const backend = cron(exec);
    await backend.apply({ entry: { launcher: ["/old/akm"], path: "/usr/bin" }, removeLegacy: [] });
    await backend.apply({ entry: { launcher: ["/new/akm"] }, removeLegacy: [] });

    expect(entryCount(exec.current())).toBe(1);
    expect((await backend.inspect()).entry).toEqual({ launcher: ["/new/akm"] });

    await backend.apply({ entry: null, removeLegacy: [] });
    expect(exec.current()).toBe("0 3 * * * /usr/local/bin/mine\n");
  });

  test("a 0.9.32 crontab ends with exactly one entry: every task block and the env block go in one write", async () => {
    const legacy = legacyCrontab(
      [
        { id: "improve", cron: "0 2 * * *", stashDir: "/home/u/akm" },
        { id: "refresh", cron: "*/30 * * * *", stashDir: "/home/u/akm", disabled: true },
        { id: "nightly", cron: "0 4 * * 1-5", stashDir: "/home/u/akm", bundle: "work" },
      ],
      { launcher: "/usr/bin/node /usr/lib/node_modules/akm-cli/dist/akm", logDir: LOG_DIR },
    );
    const exec = memoryCron(legacy);
    const backend = cron(exec);

    const before = await backend.inspect();
    expect(before.entry).toBeUndefined();
    expect(before.legacy).toEqual([
      { id: "improve", environment: { AKM_BUNDLE_DIR: "/home/u/akm" } },
      { id: "refresh", environment: { AKM_BUNDLE_DIR: "/home/u/akm" } },
      { id: "nightly", environment: { AKM_BUNDLE_DIR: "/home/u/akm" } },
    ]);

    await backend.apply({
      entry: { launcher: LAUNCHER, path: "/usr/bin:/bin" },
      removeLegacy: before.legacy.map((row) => row.id),
    });

    expect(exec.writes).toHaveLength(1);
    const after = exec.current();
    expect(entryCount(after)).toBe(1);
    expect(after).not.toContain("# akm:task");
    expect(after).not.toContain("# akm:env");
    expect(after).not.toContain("--scheduled");
    expect(after.startsWith("MAILTO=ops@example.test\n17 4 * * * /usr/local/bin/backup-home\n")).toBe(true);
    expect((await backend.inspect()).legacy).toEqual([]);
  });

  test("a row left behind keeps the shared PATH block it needs; the entry goes in beside it", async () => {
    const legacy = legacyCrontab(
      [
        { id: "mine", cron: "0 2 * * *", stashDir: "/home/u/akm" },
        { id: "theirs", cron: "0 3 * * *", stashDir: "/tmp/sandbox/stash" },
      ],
      { launcher: "/usr/bin/akm", logDir: LOG_DIR },
    );
    const exec = memoryCron(legacy);
    const backend = cron(exec);

    await backend.apply({ entry: { launcher: LAUNCHER }, removeLegacy: ["mine"] });

    const after = exec.current();
    expect(after).toContain("# akm:task theirs BEGIN");
    expect(after).not.toContain("# akm:task mine");
    expect(after).toContain("# akm:env BEGIN");
    expect(entryCount(after)).toBe(1);
  });

  test("a row too long for one cron line was spilled into a wrapper script: its environment is read from the script, and the script goes with the row", async () => {
    const script = `${LOG_DIR}/.akm-cron-wrapper-long-0123456789abcdef.sh`;
    const block = [
      "# akm:task long BEGIN",
      `0 2 * * * sh ${script} > ${LOG_DIR}/long.log 2>&1`,
      "# akm:task long END",
    ].join("\n");
    const exec = memoryCron(`${block}\n`);
    const removed: string[] = [];
    const backend = cron(exec, {
      readFile: () =>
        "#!/bin/sh\nexport AKM_BUNDLE_DIR='/srv/other stash'\nexport AKM_STATE_DIR=/srv/state\nexec /usr/bin/akm task run long --scheduled\n",
      removeFile: (file) => removed.push(file),
    });

    expect((await backend.inspect()).legacy).toEqual([
      { id: "long", environment: { AKM_BUNDLE_DIR: "/srv/other stash", AKM_STATE_DIR: "/srv/state" } },
    ]);
    await backend.apply({ removeLegacy: ["long"] });

    expect(exec.current()).toBe("");
    expect(removed).toEqual([script]);
  });

  test("creates the log directory the entry redirects into, before writing", async () => {
    const exec = memoryCron();
    const created: string[] = [];
    await CRON_BACKEND({ exec, logDir: LOG_DIR, ensureDir: (dir) => created.push(dir) }).apply({
      entry: { launcher: LAUNCHER },
      removeLegacy: [],
    });
    expect(created).toEqual([LOG_DIR]);
  });

  test("a failed write restores the crontab it replaced", async () => {
    const exec = memoryCron("0 3 * * * /usr/local/bin/mine\n");
    const backend = cron(exec);
    exec.failNextWrite();

    await expect(settle(() => backend.apply({ entry: { launcher: LAUNCHER }, removeLegacy: [] }))).rejects.toThrow(
      /crontab - failed/,
    );

    expect(exec.current()).toBe("0 3 * * * /usr/local/bin/mine\n");
  });

  test("an empty crontab ('no crontab for user', or silence from a supercronic shim) reads as empty", async () => {
    for (const [stdout, stderr] of [
      ["", "no crontab for founder"],
      ["", ""],
    ] as const) {
      const backend = cron({
        read: () => ({ status: 1, stdout, stderr }),
        write: () => ({ status: 0, stdout: "", stderr: "" }),
      });
      expect(await backend.inspect()).toEqual({ legacy: [] });
    }
  });

  test("a missing crontab binary reads as empty, and is an error only when an entry has to be written", async () => {
    const written: string[] = [];
    const backend = cron({
      read: () => ({ status: 1, stdout: "", stderr: "", enoent: true }),
      write: (content) => {
        written.push(content);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(await backend.inspect()).toEqual({ legacy: [] });
    await backend.apply({ entry: null, removeLegacy: [] });
    expect(written).toEqual([]);
    await expect(settle(() => backend.apply({ entry: { launcher: LAUNCHER }, removeLegacy: [] }))).rejects.toThrow(
      /binary was not found/,
    );
  });

  test("a malformed akm block is refused rather than rewritten", async () => {
    const exec = memoryCron("# akm:task broken BEGIN\n0 2 * * * /bin/true\n");
    await expect(settle(() => cron(exec).apply({ entry: { launcher: LAUNCHER }, removeLegacy: [] }))).rejects.toThrow(
      /malformed/,
    );
    expect(exec.writes).toEqual([]);
  });

  test("a legacy block in the fixture format is the one a 0.9.32 launcher wrote", () => {
    expect(legacyCronBlock({ id: "a", cron: "0 2 * * *", stashDir: "/s" }, "/usr/bin/akm", "/l")).toBe(
      "# akm:task a BEGIN\n0 2 * * * AKM_BUNDLE_DIR=/s /usr/bin/akm task run a --bundle stash --scheduled > /l/a.log 2>&1\n# akm:task a END",
    );
  });
});

// ── launchd ─────────────────────────────────────────────────────────────────

interface Launchd {
  backend: ReturnType<typeof LAUNCHD_BACKEND>;
  commands: string[][];
  files: Map<string, string>;
}

function fakeLaunchd(files: Record<string, string> = {}, options: { failBootstrap?: boolean } = {}): Launchd {
  const store = new Map(Object.entries(files));
  const commands: string[][] = [];
  const exec: LaunchdExec = {
    uid: () => 501,
    run(args) {
      commands.push(args);
      if (options.failBootstrap && args[1] === "bootstrap")
        return { status: 5, stdout: "", stderr: "Bootstrap failed" };
      if (args[1] === "bootout") return { status: 113, stdout: "", stderr: "Could not find service" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const fs: LaunchdFs = {
    ensureDir() {},
    writeFile: (file, content) => void store.set(file, content),
    readFile: (file) => store.get(file) ?? "",
    removeFile: (file) => void store.delete(file),
    replaceFile(source, destination) {
      store.set(destination, store.get(source) ?? "");
      store.delete(source);
    },
    list: (dir) =>
      [...store.keys()].filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1)),
    exists: (file) => store.has(file) || [...store.keys()].some((key) => key.startsWith(`${file}/`)),
  };
  return {
    backend: LAUNCHD_BACKEND({ exec, fs, agentsDir: "/Users/u/Library/LaunchAgents", logDir: LOG_DIR }),
    commands,
    files: store,
  };
}

const LEGACY_PLIST = (id: string, stash: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <!-- akm-enabled:true -->
  <key>Label</key>
  <string>com.akm.task.${id}</string>
  <key>ProgramArguments</key>
  <array>
      <string>/usr/local/bin/akm</string>
      <string>task</string>
      <string>run</string>
      <string>${id}</string>
      <string>--bundle</string>
      <string>stash</string>
      <string>--scheduled</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin</string>
    <key>AKM_BUNDLE_DIR</key>
    <string>${stash.replaceAll("&", "&amp;")}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
`;

describe("launchd backend", () => {
  test("the plist runs `task dispatch` every clock minute and abandons its process group", () => {
    const xml = buildPlistXml({ launcher: ["/opt/my akm/akm", "x&y"], path: "/usr/bin:/bin" }, LOG_DIR);

    expect(xml).toContain("<string>com.akm.dispatch</string>");
    expect(xml).toContain("<string>/opt/my akm/akm</string>");
    expect(xml).toContain("<string>x&amp;y</string>");
    expect(xml).toMatch(/<string>task<\/string>\s*<string>dispatch<\/string>/);
    expect(xml).toContain("<key>AbandonProcessGroup</key>\n  <true/>");
    expect(xml).toMatch(/<key>StartCalendarInterval<\/key>\s*<dict\/>/);
    expect(xml).toMatch(/<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin<\/string>/);
    expect(xml).toContain(`<string>${LOG_DIR}/dispatch.log</string>`);
    expect(xml).not.toContain("AKM_");
  });

  test("installs by bootout, replace, enable, bootstrap, and reads back what it wrote", async () => {
    const { backend, commands, files } = fakeLaunchd();

    await backend.apply({ entry: { launcher: ["/opt/akm", "--flag"], path: "/usr/bin" }, removeLegacy: [] });

    expect(commands.map((args) => args.slice(0, 3).join(" "))).toEqual([
      "launchctl bootout gui/501/com.akm.dispatch",
      "launchctl enable gui/501/com.akm.dispatch",
      "launchctl bootstrap gui/501",
    ]);
    expect([...files.keys()]).toEqual(["/Users/u/Library/LaunchAgents/com.akm.dispatch.plist"]);
    expect(await backend.inspect()).toEqual({
      entry: { launcher: ["/opt/akm", "--flag"], path: "/usr/bin" },
      legacy: [],
    });
  });

  test("a failed bootstrap is reported, and the temporary file is not left behind", async () => {
    const { backend, files } = fakeLaunchd({}, { failBootstrap: true });
    await expect(settle(() => backend.apply({ entry: { launcher: ["/opt/akm"] }, removeLegacy: [] }))).rejects.toThrow(
      /bootstrap failed/,
    );
    expect([...files.keys()].some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  test("every com.akm.task.* agent of a 0.9.32 install is removed with the entry installed", async () => {
    const dir = "/Users/u/Library/LaunchAgents";
    const { backend, commands, files } = fakeLaunchd({
      [`${dir}/com.akm.task.improve.plist`]: LEGACY_PLIST("improve", "/Users/u/akm"),
      [`${dir}/com.akm.task.refresh.plist`]: LEGACY_PLIST("refresh", "/Users/u/akm"),
      [`${dir}/com.apple.thing.plist`]: "<plist/>",
    });

    const before = await backend.inspect();
    expect(before.legacy).toEqual([
      { id: "improve", environment: { PATH: "/usr/bin:/bin", AKM_BUNDLE_DIR: "/Users/u/akm" } },
      { id: "refresh", environment: { PATH: "/usr/bin:/bin", AKM_BUNDLE_DIR: "/Users/u/akm" } },
    ]);
    await backend.apply({ entry: { launcher: ["/opt/akm"] }, removeLegacy: ["improve", "refresh"] });

    expect([...files.keys()].sort()).toEqual([`${dir}/com.akm.dispatch.plist`, `${dir}/com.apple.thing.plist`]);
    expect(commands.filter((args) => args[1] === "bootout").map((args) => args[2])).toEqual([
      "gui/501/com.akm.task.improve",
      "gui/501/com.akm.task.refresh",
      "gui/501/com.akm.dispatch",
    ]);
    expect((await backend.inspect()).legacy).toEqual([]);
  });

  test("null boots the entry out and deletes its plist", async () => {
    const { backend, files } = fakeLaunchd();
    await backend.apply({ entry: { launcher: ["/opt/akm"] }, removeLegacy: [] });
    await backend.apply({ entry: null, removeLegacy: [] });
    expect(files.size).toBe(0);
  });
});

// ── schtasks ────────────────────────────────────────────────────────────────

interface Schtasks {
  backend: ReturnType<typeof SCHTASKS_BACKEND>;
  commands: string[][];
  created: string[];
}

function fakeSchtasks(tasks: Record<string, string> = {}): Schtasks {
  const commands: string[][] = [];
  const created: string[] = [];
  const store = new Map(Object.entries(tasks));
  const exec: SchtasksExec = {
    run(args) {
      commands.push(args);
      if (args[0] === "whoami") return { status: 0, stdout: '"host\\u","S-1-5-21-1-2-3-1001"', stderr: "" };
      if (args[1] === "/Query" && args.includes("/FO")) {
        return {
          status: 0,
          stdout: [...store.keys()].map((name) => `"${name}","N/A","Ready"`).join("\r\n"),
          stderr: "",
        };
      }
      if (args[1] === "/Query") return { status: 0, stdout: store.get(args[3] as string) ?? "", stderr: "" };
      if (args[1] === "/Delete") {
        if (!store.has(args[3] as string))
          return { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
        store.delete(args[3] as string);
      }
      if (args[1] === "/Create") {
        created.push(args[3] as string);
        store.set(args[3] as string, createdXml);
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  let createdXml = "";
  const fs: SchtasksFs = {
    ensureDir() {},
    writeFile: (_file, content) => {
      createdXml = content;
    },
    removeFile() {},
    tmpdir: () => "C:\\Temp",
  };
  return {
    backend: SCHTASKS_BACKEND({ exec, fs, userSid: "S-1-5-21-1-2-3-1001", now: () => new Date(2026, 10, 9, 14, 5) }),
    commands,
    created,
  };
}

const LEGACY_TASK_XML = (stash: string) =>
  `<Task><Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoLogo -Command "$env:AKM_BUNDLE_DIR='${stash}'; &amp; 'C:\\akm.exe' 'task' 'run' 'improve' 'exit $LASTEXITCODE'"</Arguments></Exec></Actions></Task>`;

describe("schtasks backend", () => {
  test("the task runs the launcher directly, every minute, and records the launcher argv in its Source", () => {
    const xml = buildSchtasksXml(
      { launcher: ["C:\\Program Files\\akm\\akm.exe"] },
      { userSid: "S-1-5-21-1-2-3-1001", now: () => new Date(2026, 10, 9, 14, 5) },
    );

    expect(xml).toContain("<URI>\\akm\\dispatch</URI>");
    expect(xml).toContain("<Command>C:\\Program Files\\akm\\akm.exe</Command>");
    expect(xml).toContain("<Arguments>task dispatch</Arguments>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<StartBoundary>2026-11-09T00:00:00</StartBoundary>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<UserId>S-1-5-21-1-2-3-1001</UserId>");
    expect(xml).not.toContain("powershell");
    expect(xml).not.toContain("AKM_");
  });

  test("a launcher with arguments quotes the ones that need it", () => {
    const xml = buildSchtasksXml(
      { launcher: ["C:\\node.exe", "C:\\Program Files\\akm\\dist\\akm"] },
      { userSid: "S-1" },
    );
    expect(xml).toContain("<Arguments>&quot;C:\\Program Files\\akm\\dist\\akm&quot; task dispatch</Arguments>");
  });

  test("installs under \\akm\\dispatch with /F, and reads the launcher back", async () => {
    const { backend, commands, created } = fakeSchtasks();

    await backend.apply({ entry: { launcher: ["C:\\akm.exe", "--x"] }, removeLegacy: [] });

    expect(created).toEqual(["\\akm\\dispatch"]);
    expect(commands.some((args) => args[1] === "/Create" && args.includes("/F"))).toBe(true);
    expect((await backend.inspect()).entry).toEqual({ launcher: ["C:\\akm.exe", "--x"] });
  });

  test("every \\akm\\<id> task of a 0.9.32 install is deleted with the entry installed; other folders are never touched", async () => {
    const { backend, commands } = fakeSchtasks({
      "\\akm\\improve": LEGACY_TASK_XML("C:\\Users\\u\\akm"),
      "\\akm\\refresh": LEGACY_TASK_XML("C:\\Users\\u\\akm"),
      "\\Microsoft\\Windows\\Defrag": "<Task/>",
    });

    const before = await backend.inspect();
    expect(before.legacy).toEqual([
      { id: "improve", environment: { AKM_BUNDLE_DIR: "C:\\Users\\u\\akm" } },
      { id: "refresh", environment: { AKM_BUNDLE_DIR: "C:\\Users\\u\\akm" } },
    ]);
    await backend.apply({ entry: { launcher: ["C:\\akm.exe"] }, removeLegacy: ["improve", "refresh"] });

    expect(commands.filter((args) => args[1] === "/Delete").map((args) => args[3])).toEqual([
      "\\akm\\improve",
      "\\akm\\refresh",
    ]);
    const after = await backend.inspect();
    expect(after.legacy).toEqual([]);
    expect(after.entry).toEqual({ launcher: ["C:\\akm.exe"] });
  });

  test("null deletes the entry; deleting what is already gone is not an error", async () => {
    const { backend } = fakeSchtasks();
    await expect(settle(() => backend.apply({ entry: null, removeLegacy: [] }))).resolves.toBeUndefined();
  });
});

// ── the safety branches: what must never be read as empty, written, or mangled ──────────────────────────────────

describe("cron: a crontab that cannot be read is never an empty crontab", () => {
  const writes: string[] = [];
  const failing = (result: CronExecResult): CronExec => ({
    read: () => result,
    write: (content) => {
      writes.push(content);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  test("a refusal that says something other than 'no crontab' fails both the read and every write, and writes nothing", async () => {
    writes.length = 0;
    const backend = cron(failing({ status: 1, stdout: "", stderr: "crontab: permission denied" }));

    await expect(settle(() => backend.inspect())).rejects.toThrow(/crontab -l failed \(exit 1\).*permission denied/);
    await expect(settle(() => backend.apply({ entry: { launcher: LAUNCHER }, removeLegacy: [] }))).rejects.toThrow(
      /crontab -l failed/,
    );
    await expect(settle(() => backend.apply({ entry: null, removeLegacy: [] }))).rejects.toThrow(/crontab -l failed/);
    expect(writes).toEqual([]);
  });

  test("an unexplained non-zero exit with output on stdout is a failure, not an empty crontab", async () => {
    const backend = cron(failing({ status: 2, stdout: "0 3 * * * /usr/local/bin/mine\n", stderr: "" }));
    await expect(settle(() => backend.inspect())).rejects.toThrow(/crontab -l failed \(exit 2\)/);
  });

  test("under no-new-privileges a permission refusal says why, and still writes nothing", async () => {
    writes.length = 0;
    const backend = cron(
      failing({ status: 1, stdout: "", stderr: "crontab: fopen: Permission denied", noNewPrivileges: true }),
    );
    await expect(settle(() => backend.apply({ entry: { launcher: LAUNCHER }, removeLegacy: [] }))).rejects.toThrow(
      /no-new-privileges/,
    );
    expect(writes).toEqual([]);
  });

  test("without no-new-privileges the same refusal is reported as what it said", async () => {
    const backend = cron(failing({ status: 1, stdout: "", stderr: "crontab: fopen: Permission denied" }));
    const error = await settle(() => backend.inspect()).catch((e: Error) => e);
    expect((error as Error).message).toContain("Permission denied");
    expect((error as Error).message).not.toContain("no-new-privileges");
  });
});

describe("cron: a control character never reaches a crontab line", () => {
  test.each([
    ["a newline in the launcher", { launcher: ["/opt/akm\ninjected"] }],
    ["a bell in the launcher", { launcher: ["/opt/ak\x07m"] }],
    ["a DEL-range character in the PATH", { launcher: LAUNCHER, path: "/usr/bin:/b\x85in" }],
  ])("%s is refused and nothing is written", async (_name, entry) => {
    const exec = memoryCron("0 3 * * * /usr/local/bin/mine\n");
    await expect(settle(() => cron(exec).apply({ entry, removeLegacy: [] }))).rejects.toThrow(/control characters/);
    expect(exec.writes).toEqual([]);
    expect(exec.current()).toBe("0 3 * * * /usr/local/bin/mine\n");
  });
});

describe("launchd: a control character never reaches the plist", () => {
  test("the plist builder refuses XML-forbidden control characters, in the launcher and in PATH", () => {
    expect(() => buildPlistXml({ launcher: ["/opt/ak\x07m"] }, LOG_DIR)).toThrow(/control characters/);
    expect(() => buildPlistXml({ launcher: LAUNCHER, path: "/usr/bin:\x1b/bin" }, LOG_DIR)).toThrow(
      /control characters/,
    );
    expect(buildPlistXml({ launcher: ["/opt/with\ttab"] }, LOG_DIR)).toContain("/opt/with\ttab");
  });
});

describe("decodeCommandOutput: Task Scheduler writes UTF-16", () => {
  const xml = '<Task><Source>akm:v2:["C:\\akm.exe"]</Source></Task>';
  test("UTF-16LE with a BOM, UTF-16LE without one, UTF-16BE with a BOM, UTF-8 with a BOM and plain text all decode", () => {
    const le = Buffer.from(xml, "utf16le");
    expect(decodeCommandOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))).toBe(xml);
    expect(decodeCommandOutput(le)).toBe(xml);
    const be = Buffer.from(le).swap16();
    expect(decodeCommandOutput(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(xml);
    expect(decodeCommandOutput(be)).toBe(xml);
    expect(decodeCommandOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]))).toBe(xml);
    expect(decodeCommandOutput(Buffer.from(xml))).toBe(xml);
    expect(decodeCommandOutput("\uFEFF" + xml)).toBe(xml);
    expect(decodeCommandOutput(null)).toBe("");
    expect(decodeCommandOutput(Buffer.alloc(0))).toBe("");
  });

  test("an entry whose XML was emitted as UTF-16 is read back through the exec seam's decoder", async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(buildSchtasksXml({ launcher: ["C:\\akm.exe"] }, { userSid: "S-1-5-21-1-2-3-1001" }), "utf16le"),
    ]);
    const exec: SchtasksExec = {
      run: (args) =>
        args.includes("/FO")
          ? { status: 0, stdout: '"\\akm\\dispatch","N/A","Ready"', stderr: "" }
          : { status: 0, stdout: decodeCommandOutput(utf16), stderr: "" },
    };
    const reader = SCHTASKS_BACKEND({ exec, userSid: "S-1-5-21-1-2-3-1001" });
    expect((await reader.inspect()).entry).toEqual({ launcher: ["C:\\akm.exe"] });
  });
});
