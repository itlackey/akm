import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/** No AKM import occurs here. Apply returned env before any AKM import. */
export async function createFixture({
  runtime = process.execPath,
  index = true,
  packageRoot,
  assetCount = 0,
  git = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "akm-desktop-fixture-"));
  // Allow only host runtime/display basics. Never inherit credentials, agent
  // sockets, provider endpoints, NODE_OPTIONS or the caller's AKM overrides.
  const allowed = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ];
  const env = Object.fromEntries(
    allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    TMPDIR: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    AKM_CONFIG_DIR: path.join(root, "config"),
    AKM_DATA_DIR: path.join(root, "data"),
    AKM_CACHE_DIR: path.join(root, "cache"),
    AKM_STATE_DIR: path.join(root, "state"),
    AKM_BUNDLE_DIR: path.join(root, "personal"),
    NO_PROXY: "127.0.0.1,localhost",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_COLOR: "1",
  });
  const put = async (relative, content) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
  };
  for (const key of [
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "AKM_DATA_DIR",
    "AKM_STATE_DIR",
  ])
    await mkdir(env[key], { recursive: true });
  const bundles = Object.fromEntries(
    ["personal", "shared", "vendor"].map((name) => [
      name,
      { path: path.join(root, name), writable: name !== "vendor" },
    ]),
  );
  await put(
    "config/config.json",
    JSON.stringify(
      { semanticSearchMode: "off", defaultBundle: "personal", defaultWriteTarget: "personal", bundles },
      null,
      2,
    ),
  );
  const content =
    "---\ntitle: Restore a laptop\ndescription: Synthetic backup and recovery checklist\n---\n# Restore a laptop\n\nVerify the checksum before restoring a backup.\n";
  const documentPath = await put("personal/knowledge/restore-laptop.md", content);
  await put(
    "personal/memories/backup-preference.md",
    "---\ntitle: Backup preference\ndescription: Synthetic durable preference for edit verification\n---\n# Backup preference\n\nKeep one verified offline copy.\n",
  );
  await put(
    "personal/commands/check-recovery.md",
    "---\ndescription: Synthetic recovery command\n---\n# Check recovery\n\nReview the recovery evidence for $ARGUMENTS before proceeding.\n",
  );
  await put(
    "personal/agents/recovery-reviewer.md",
    "---\ndescription: Synthetic recovery reviewer\nmode: subagent\n---\n# Recovery reviewer\n\nExplain which recovery checks are incomplete.\n",
  );
  await put(
    "shared/knowledge/shared-backup.md",
    "---\ntitle: Shared backup\ndescription: Synthetic shared backup checklist\n---\n# Shared backup\n\nKeep the original disk.\n",
  );
  const vendorPath = await put(
    "vendor/knowledge/vendor-backup.md",
    "---\ntitle: Vendor backup\ndescription: Synthetic read-only backup reference\n---\n# Vendor backup\n\nUse the vendor tool.\n",
  );
  await put(
    "personal/skills/backup-check/SKILL.md",
    "---\nname: backup-check\ndescription: Synthetic backup skill with helper files\n---\n# Backup check\n\nInspect [checklist](references/checklist.md).\n",
  );
  await put("personal/skills/backup-check/references/checklist.md", "# Checklist\n\n- Verify checksum\n");
  await put("personal/skills/backup-check/scripts/check.sh", '#!/bin/sh\nprintf "Synthetic only\\n"\n');
  await put(
    "personal/knowledge/untrusted.md",
    '---\ntitle: Untrusted content\ndescription: Synthetic malicious markdown test\n---\n# Untrusted\n<script>window.__akmInjected = true</script>\n<img src=x onerror="window.__akmInjected=true">\n[Unsafe](javascript:alert(1))\n',
  );
  for (let n = 0; n < assetCount; n++)
    await put(
      `personal/knowledge/reference-${String(n).padStart(3, "0")}.md`,
      `---\ntitle: Reference ${n}\ndescription: Synthetic searchable maintenance reference ${n}\ntags: [maintenance, fixture]\n---\n# Reference ${n}\n\nUse the verified maintenance procedure.\n\n## Evidence\n\nRetain the measured result for reference ${n}.\n`,
    );
  if (git) {
    const command = (args) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: env.AKM_BUNDLE_DIR, env, stdio: "pipe" });
    command(["init", "--quiet"]);
    command(["config", "user.name", "Synthetic UI test"]);
    command(["config", "user.email", "fixture@example.test"]);
    command(["add", "."]);
    command(["commit", "-qm", "Initial synthetic reference library"]);
    await writeFile(documentPath, content + "\nA committed verification step.\n");
    command(["add", "knowledge/restore-laptop.md"]);
    command(["commit", "-qm", "Add verified recovery step"]);
  }
  const require = createRequire(packageRoot ? path.join(packageRoot, "package.json") : import.meta.url);
  const launcher = path.join(path.dirname(require.resolve("akm-cli/package.json")), "dist", "cli-node.mjs");
  if (index)
    execFileSync(runtime, [launcher, "index", "--full", "--format", "json", "-q"], {
      env,
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  return {
    root,
    env,
    launcher,
    content,
    documentPath,
    vendorPath,
    refs: {
      document: "personal//knowledge/restore-laptop",
      memory: "personal//memories/backup-preference",
      shared: "shared//knowledge/shared-backup",
      vendor: "vendor//knowledge/vendor-backup",
      skill: "personal//skills/backup-check",
      malicious: "personal//knowledge/untrusted",
    },
    // Retained synthetic fixtures aid failure diagnosis; never remove source or live data.
    cleanup: async () => {},
  };
}
