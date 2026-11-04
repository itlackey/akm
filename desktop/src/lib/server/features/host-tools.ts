// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "jsonc-parser";

type Env = NodeJS.ProcessEnv;
// Native CLI output is untyped JSON; each reader below checks the fields it uses.
// biome-ignore lint/suspicious/noExplicitAny: parsed output of host commands
type Loose = any;
type Run = (file: string, args: string[], options: { env?: Env; home?: string; timeout?: number }) => Promise<string>;
type Find = (name: string, env?: Env) => Promise<string | undefined>;
export interface PluginState {
  state: "installed" | "disabled" | "missing" | "configured" | "unknown";
  version?: string;
  note?: string;
  spec?: string;
  file?: string;
  /** Why a plugin could not be verified: the underlying error, for the Details line. */
  detail?: string;
}
export interface Detected {
  id: string;
  installed: boolean;
  path?: string;
  version?: string;
  runnable?: boolean;
  plugin?: PluginState;
  major?: number;
}
export interface HostState {
  phase: string;
  cli: Detected | null;
  /** Where Install AKM CLI puts akm, as the person would write it. */
  cliDirectory: string;
  /** The Claude Code and Codex plugin hooks run on Bun (`bun akm-hook.ts`); the standalone akm CLI does not provide it. */
  bun: (Detected & { installCommand: string }) | null;
  harnesses: Detected[];
  checkedAt?: string;
  /** What went wrong, in words for the person using the app. */
  error?: string;
  /** The underlying cause (message and the command's stderr tail), shown under Details. */
  errorDetail?: string;
  receipt?: string;
  command?: string;
  upgrade?: Record<string, string | boolean>;
}

const exec = promisify(execFile);
// The harness plugin-install recipe (plugin id, marketplace and channel syntax, OpenCode v1/v2 shapes) is kept here on
// purpose, with no akm surface. The source of truth is akm's src/commands/sources/plugin-channels.ts and
// plugin-upgrade.ts: change them together.
const pluginId = "akm@akm-plugins";
export const harnessIds = ["claude", "codex", "opencode", "opencode2"];
/** Bun's own installer, shown for the person to run: Desktop never runs it. https://bun.sh/docs/installation */
export const bunInstallCommand = (platform: string) =>
  platform === "win32" ? 'powershell -c "irm bun.sh/install.ps1 | iex"' : "curl -fsSL https://bun.sh/install | bash";
/**
 * Where the release installer puts akm for Desktop: `~/.local/bin` on Linux and macOS, and on Windows install.ps1's own
 * default, `%LOCALAPPDATA%\akm`, which it also adds to the user's PATH.
 */
function cliDirectory(platform: string, env: Env, home: string) {
  return platform === "win32"
    ? { path: path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "akm"), shown: "%LOCALAPPDATA%\\akm" }
    : { path: path.join(home, ".local/bin"), shown: "~/.local/bin" };
}
const versionOf = (text: string | undefined) => text?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
class SoftwareError extends Error {}

export async function hostEnvironment(
  env: Env = process.env,
  home = os.homedir(),
  platform: string = process.platform,
) {
  const next = { ...env };
  // Electron's Node child uses a launcher for bundled workspace commands.
  // Never pass it (or the private session) to the real host CLI/harnesses.
  for (const key of Object.keys(next))
    if (/^AKM_(?:LAUNCHER_|DESKTOP_)/.test(key) || ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"].includes(key))
      delete next[key];
  const paths = (next.PATH ?? "").split(path.delimiter).filter((item) => path.isAbsolute(item));
  const extra = [".local/bin", ".bun/bin", ".opencode/bin"].map((item) => path.join(home, item));
  if (platform === "win32") extra.push(cliDirectory(platform, next, home).path);
  try {
    const nvm = path.join(next.NVM_DIR || path.join(home, ".nvm"), "versions/node");
    const versions = (await readdir(nvm))
      .filter((item) => /^v\d+\.\d+\.\d+$/.test(item))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    extra.push(...versions.map((item) => path.join(nvm, item, "bin")));
  } catch {
    /* NVM is optional; do not run shell startup files. */
  }
  next.PATH = [...new Set([...paths, ...extra])].join(path.delimiter);
  return next;
}

export const findProgram: Find = async (name, env = process.env) => {
  // Windows programs carry their extension; akm and Bun install as .exe there.
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter((item) => path.isAbsolute(item))) {
    for (const file of names.map((item) => path.join(directory, item))) {
      try {
        await access(file, constants.X_OK);
        return file;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
};

export const runHost: Run = async (file, args, { env, home, timeout = 30_000 }) => {
  const pending = exec(file, args, {
    env,
    cwd: home,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  pending.child.stdin?.end(); // Native consent must not hang on an unattended input pipe.
  const result = await pending;
  return result.stdout;
};

function json(text: string): Loose {
  const value = JSON.parse(text);
  // AKM's normal JSON is the payload; tolerate an explicitly enveloped response.
  if (value?.ok === false) throw new Error("AKM reported a failed operation.");
  return value?.data ?? value;
}

// The same lookup as akm's `openCodeConfigSpec` (src/commands/sources/plugin-upgrade.ts), so Software and `akm upgrade`
// agree on which plugin OpenCode loads: opencode.jsonc before opencode.json, OPENCODE_CONFIG only for OpenCode 1, and
// for OpenCode 1 the first global file that sets the list decides. Unlike akm, a file Desktop cannot read stops the
// check (the plugin shows as unverified) rather than being skipped.
async function openCodePlugin(env: Env, home: string, major: number) {
  const directory =
    env.OPENCODE_CONFIG_DIR?.trim() || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  const explicit = major === 2 ? undefined : env.OPENCODE_CONFIG?.trim();
  const files = [explicit, path.join(directory, "opencode.jsonc"), path.join(directory, "opencode.json")].filter(
    Boolean,
  );
  const pkg = major === 2 ? "akm-opencode-v2" : "akm-opencode";
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file as string, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const errors: unknown[] = [],
      config = parse(text, errors as never[], { allowTrailingComma: true });
    if (errors.length || !config || typeof config !== "object")
      throw new Error("OpenCode configuration could not be read.");
    let setsList = false;
    for (const key of major === 2 ? ["plugins", "plugin"] : ["plugin"]) {
      if (config[key] !== undefined && !Array.isArray(config[key]))
        throw new Error("OpenCode plugin configuration is not a list.");
      if (config[key] !== undefined) setsList = true;
      for (const entry of config[key] ?? []) {
        const spec = Array.isArray(entry) ? entry[0] : entry;
        if (typeof spec === "string" && (spec === pkg || spec.startsWith(`${pkg}@`))) return { spec, file };
      }
    }
    if (setsList && file !== explicit && major === 1) return undefined;
  }
  return undefined;
}

function errorMessage(error: Loose) {
  if (error instanceof SoftwareError) return error.message;
  if (error?.code === "EACCES" || error?.code === "EPERM")
    return "Permission denied. Use the installer that owns this CLI; Desktop will not use sudo.";
  if (error?.killed || error?.code === "ETIMEDOUT")
    return "The command timed out. Check its native status before retrying.";
  return "The native command did not complete successfully. Check the connection and use the command shown in Details for diagnostics.";
}

/** The underlying cause of a failure: its message and the end of the command's stderr, bounded. */
export function errorDetail(error: unknown): string | undefined {
  if (error instanceof SoftwareError) return undefined;
  const cause = error as { message?: unknown; stderr?: unknown };
  const parts = [cause?.message, typeof cause?.stderr === "string" ? cause.stderr.trim().slice(-500) : undefined]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => part.trim());
  return parts.length ? [...new Set(parts)].join("\n").slice(0, 1000) : undefined;
}

/** Host lifecycle only. All upgrades/migration/plugin writes are native commands. */
export class HostTools {
  home: string;
  sourceEnv: Env;
  run: Run;
  find: Find;
  fetcher: typeof fetch;
  platform: string;
  desktopVersion?: string;
  state: HostState;
  pending?: Promise<void>;
  constructor({
    home = os.homedir(),
    env = process.env,
    run = runHost,
    find = findProgram,
    fetcher = fetch,
    platform = process.platform,
    desktopVersion = process.env.AKM_DESKTOP_VERSION,
  }: {
    home?: string;
    env?: Env;
    run?: Run;
    find?: Find;
    fetcher?: typeof fetch;
    platform?: string;
    desktopVersion?: string;
  } = {}) {
    this.home = home;
    this.sourceEnv = env;
    this.run = run;
    this.find = find;
    this.fetcher = fetcher;
    this.platform = platform;
    this.desktopVersion = desktopVersion;
    this.state = {
      phase: "idle",
      cli: null,
      cliDirectory: cliDirectory(platform, env, home).shown,
      bun: null,
      harnesses: [],
      checkedAt: undefined,
      error: undefined,
      receipt: undefined,
    };
  }
  snapshot() {
    return structuredClone(this.state);
  }
  async environment() {
    return hostEnvironment(this.sourceEnv, this.home, this.platform);
  }
  async invoke(file: string, args: string[], env: Env, timeout?: number) {
    return this.run(file, args, { env, home: this.home, timeout });
  }
  async detect(name: string, env: Env): Promise<Detected> {
    const file = await this.find(name, env);
    if (!file) return { id: name, installed: false };
    try {
      const version = versionOf(await this.invoke(file, ["--version"], env));
      return { id: name, installed: true, path: file, version, runnable: Boolean(version) };
    } catch {
      return { id: name, installed: true, path: file, runnable: false };
    }
  }
  async inventory(env: Env) {
    const cli = await this.detect("akm", env);
    const bun = { ...(await this.detect("bun", env)), installCommand: bunInstallCommand(this.platform) };
    const harnesses = await Promise.all(
      harnessIds.map(async (id) => {
        const harness = await this.detect(id, env);
        if (!harness.runnable || !harness.path) return harness;
        try {
          if (id === "claude") {
            const list = json(await this.invoke(harness.path, ["plugin", "list", "--json"], env));
            if (!Array.isArray(list)) throw new Error("Unrecognized plugin inventory.");
            const item = list.find((item: Loose) => item.id === pluginId && (!item.scope || item.scope === "user"));
            harness.plugin = item
              ? { state: item.enabled === false ? "disabled" : "installed", version: item.version }
              : { state: "missing" };
          } else if (id === "codex") {
            const list = json(
              await this.invoke(harness.path, ["plugin", "list", "--marketplace", "akm-plugins", "--json"], env),
            );
            if (!Array.isArray(list?.installed)) throw new Error("Unrecognized plugin inventory.");
            const item = list.installed.find((item: Loose) => item.pluginId === pluginId);
            harness.plugin = item
              ? {
                  state: "installed",
                  version: item.version,
                  note: "Review the AKM hooks in Codex /hooks. Installation does not approve them.",
                }
              : { state: "missing" };
          } else {
            const major = Number(harness.version?.split(".")[0]);
            if (![1, 2].includes(major)) throw new Error("Unsupported OpenCode major.");
            const configured = await openCodePlugin(env, this.home, major);
            harness.plugin = configured
              ? { state: "configured", ...configured, note: "Restart OpenCode to load this plugin." }
              : { state: "missing" };
            harness.major = major;
          }
        } catch (error) {
          harness.plugin = {
            state: "unknown",
            note: "Native inventory could not verify the plugin. Review it in the harness before installing.",
            detail: errorDetail(error),
          };
        }
        return harness;
      }),
    );
    Object.assign(this.state, { cli, bun, harnesses });
  }
  start(action: string, harness?: string, channel = "latest") {
    if (
      !["check", "install-cli", "upgrade-cli", "install-plugin"].includes(action) ||
      (action === "install-plugin" && !harnessIds.includes(harness as string)) ||
      !["latest", "next"].includes(channel)
    )
      throw new Error("Invalid software action.");
    if (this.pending) throw new Error("A software operation is already running.");
    if (action !== "check" && process.send) process.send({ type: "desktop-host-operation", busy: true });
    this.state.phase = action;
    this.state.error = undefined;
    this.state.errorDetail = undefined;
    this.state.receipt = undefined;
    this.state.command = undefined;
    this.pending = Promise.resolve()
      .then(async () => {
        const env = await this.environment();
        await this.inventory(env);
        if (action === "install-cli") await this.installCli(env);
        if (action === "upgrade-cli") {
          if (!this.state.cli?.runnable || !this.state.cli.path)
            throw new SoftwareError("Install a working CLI first.");
          this.state.command = "akm upgrade --format json";
          const result = json(
            await this.invoke(this.state.cli.path, ["upgrade", "--format", "json"], env, 30 * 60_000),
          );
          // Summarize only lifecycle fields, not complete migration/file payloads.
          this.state.upgrade = summarizeUpgrade(result);
          if (
            result.migration?.status === "blocked" ||
            result.migration?.status === "failed" ||
            result.postUpgrade?.ok === false ||
            result.plugins?.some((item: Loose) => item.outcome === "failed")
          )
            throw new SoftwareError(
              "AKM reported a migration, indexing or plugin failure. Use akm upgrade in your terminal to review its diagnostics.",
            );
          this.state.receipt = "Native AKM upgrade completed. The bundled desktop engine is unchanged.";
        }
        if (action === "install-plugin") await this.installPlugin(harness as string, channel, env);
        await this.inventory(env);
        if (this.state.cli?.runnable && this.state.cli.path) {
          this.state.command = "akm upgrade --check --format json";
          const result = json(
            await this.invoke(this.state.cli.path, ["upgrade", "--check", "--format", "json"], env, 120_000),
          );
          this.state.upgrade = summarizeUpgrade(result);
        }
        this.state.checkedAt = new Date().toISOString();
      })
      .catch((error) => {
        this.state.error = errorMessage(error);
        this.state.errorDetail = errorDetail(error);
      })
      .finally(() => {
        this.state.phase = "idle";
        this.pending = undefined;
        if (action !== "check" && process.send) process.send({ type: "desktop-host-operation", busy: false });
      });
    return this.snapshot();
  }
  async installCli(env: Env) {
    if (this.state.cli?.installed) throw new SoftwareError("An existing CLI must be upgraded with its own installer.");
    if (!["linux", "darwin", "win32"].includes(this.platform))
      throw new SoftwareError("This build supports host installation on Linux, macOS and Windows.");
    const windows = this.platform === "win32";
    // The official installer verifies the release checksum and installs a
    // standalone binary. No Node/Bun prerequisite, npm-global shadow copy or sudo.
    const target = cliDirectory(this.platform, env, this.home);
    const directory = target.path;
    await mkdir(directory, { recursive: true });
    await access(directory, constants.W_OK);
    // Refuse an existing off-PATH binary too; never overwrite an unknown install.
    try {
      await access(path.join(directory, windows ? "akm.exe" : "akm"));
      throw new SoftwareError("A CLI already exists in the install directory. No files were replaced.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // The installer of Desktop's own release installs the same akm version, so host and engine start equal. A
    // development run keeps desktop/package.json's unstamped 0.0.0, has no release and takes the latest.
    const release =
      this.desktopVersion && this.desktopVersion !== "0.0.0" ? `download/v${this.desktopVersion}` : "latest/download";
    const script = windows ? "install.ps1" : "install.sh";
    const response = await this.fetcher(`https://github.com/itlackey/akm/releases/${release}/${script}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Installer download failed.");
    const text = await response.text();
    if (text.length > 128 * 1024 || !text.startsWith(windows ? "#Requires" : "#!/usr/bin/env bash"))
      throw new Error("Unexpected installer.");
    const temporary = await mkdtemp(path.join(os.tmpdir(), "akm-desktop-install-"));
    const file = path.join(temporary, script);
    try {
      await writeFile(file, text, { mode: 0o600 });
      const installEnv = { ...env, AKM_INSTALL_DIR: directory };
      if (windows) {
        // A downloaded script is blocked by the default execution policy; Bypass applies to this one process only.
        this.state.command =
          "powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 (official release installer)";
        await this.invoke(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
          installEnv,
          10 * 60_000,
        );
      } else {
        this.state.command = 'AKM_INSTALL_DIR="$HOME/.local/bin" bash install.sh (official release installer)';
        await this.invoke("/bin/bash", [file], installEnv, 10 * 60_000);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    const installed = await this.detect("akm", env);
    if (!installed.runnable) throw new Error("The installed CLI could not report a version.");
    this.state.receipt = `AKM CLI installed in ${target.shown}. ${
      windows
        ? "The installer added it to your PATH; open a new terminal to use it."
        : "Add that directory to your terminal PATH if needed; Desktop already finds it."
    }`;
  }
  async installPlugin(id: string, channel: string, env: Env) {
    const harness = this.state.harnesses.find((item) => item.id === id);
    if (!harness?.runnable || !harness.path || !this.state.cli?.runnable)
      throw new SoftwareError("Install AKM and the harness first.");
    const harnessPath = harness.path;
    if (harness.plugin?.state !== "missing")
      throw new SoftwareError("The plugin is already present or could not be verified. No change was made.");
    const command = async (args: string[]) => {
      this.state.command = [id, ...args].join(" ");
      await this.invoke(harnessPath, args, env, 180_000);
    };
    if (id === "claude" || id === "codex") {
      if (!this.state.bun?.installed)
        throw new SoftwareError("Install Bun first: the AKM hooks use it. No harness configuration was changed.");
      // List first: preserve an existing marketplace's source and release channel.
      const listed = json(await this.invoke(harnessPath, ["plugin", "marketplace", "list", "--json"], env));
      const list = Array.isArray(listed) ? listed : listed?.marketplaces;
      if (!Array.isArray(list)) throw new Error("Unrecognized marketplace inventory.");
      const exists = list.some((item: Loose) => (item.name ?? item.marketplaceName) === "akm-plugins");
      if (!exists)
        await command([
          "plugin",
          "marketplace",
          "add",
          `itlackey/akm-plugins${id === "claude" && channel === "next" ? "@next" : ""}`,
          ...(id === "codex" && channel === "next" ? ["--ref", "next"] : []),
        ]);
      await command(id === "claude" ? ["plugin", "install", pluginId, "--scope", "user"] : ["plugin", "add", pluginId]);
    } else {
      const pkg = harness.major === 2 ? "akm-opencode-v2" : "akm-opencode";
      await command(
        harness.major === 2 ? ["plugin", "add", `${pkg}@${channel}`] : ["plugin", `${pkg}@${channel}`, "--global"],
      );
    }
    await this.inventory(env);
    const after = this.state.harnesses.find((item) => item.id === id)?.plugin;
    if (!after || !["installed", "configured"].includes(after.state))
      throw new Error("The native installation could not be verified.");
    this.state.receipt =
      id === "codex"
        ? "AKM installed for Codex. Review its hooks in Codex /hooks to enable automatic recall."
        : "AKM plugin installed. Restart the harness to load it.";
  }
}

export function summarizeUpgrade(result: Loose) {
  return Object.fromEntries(
    [
      "currentVersion",
      "latestVersion",
      "newVersion",
      "updateAvailable",
      "upgraded",
      "installMethod",
      "channel",
      "currentChannel",
      "targetChannel",
    ]
      .filter((key) => ["string", "boolean"].includes(typeof result?.[key]))
      .map((key) => [key, result[key]]),
  );
}
