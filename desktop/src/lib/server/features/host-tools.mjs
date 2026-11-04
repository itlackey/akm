import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, readdir, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';

const exec = promisify(execFile);
// The harness plugin-install recipe (plugin id, marketplace and channel syntax, OpenCode v1/v2 shapes) is kept here on
// purpose, with no akm surface. The source of truth is akm's src/commands/sources/plugin-channels.ts and
// plugin-upgrade.ts: change them together.
const pluginId = 'akm@akm-plugins';
export const harnessIds = ['claude', 'codex', 'opencode', 'opencode2'];
const versionOf = text => text?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
class SoftwareError extends Error {}

export async function hostEnvironment(env = process.env, home = os.homedir()) {
  const next = { ...env };
  // Electron's Node child uses a launcher for bundled workspace commands.
  // Never pass it (or the private session) to the real host CLI/harnesses.
  for (const key of Object.keys(next)) if (/^AKM_(?:LAUNCHER_|DESKTOP_)/.test(key) ||
    ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete next[key];
  const paths = (next.PATH ?? '').split(path.delimiter).filter(item => path.isAbsolute(item));
  const extra = ['.local/bin', '.bun/bin', '.opencode/bin'].map(item => path.join(home, item));
  try {
    const nvm = path.join(next.NVM_DIR || path.join(home, '.nvm'), 'versions/node');
    const versions = (await readdir(nvm)).filter(item => /^v\d+\.\d+\.\d+$/.test(item))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    extra.push(...versions.map(item => path.join(nvm, item, 'bin')));
  } catch { /* NVM is optional; do not run shell startup files. */ }
  next.PATH = [...new Set([...paths, ...extra])].join(path.delimiter);
  return next;
}

export async function findProgram(name, env) {
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(item => path.isAbsolute(item))) {
    const file = path.join(directory, name);
    try { await access(file, constants.X_OK); return file; } catch { /* keep looking */ }
  }
  return undefined;
}

export async function runHost(file, args, { env, home, timeout = 30_000 } = {}) {
  const pending = exec(file, args, {
    env, cwd: home, timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true
  });
  pending.child.stdin?.end(); // Native consent must not hang on an unattended input pipe.
  const result = await pending;
  return result.stdout;
}

function json(text) {
  const value = JSON.parse(text);
  // AKM's normal JSON is the payload; tolerate an explicitly enveloped response.
  if (value?.ok === false) throw new Error('AKM reported a failed operation.');
  return value?.data ?? value;
}

// The same lookup as akm's `openCodeConfigSpec` (src/commands/sources/plugin-upgrade.ts), so Software and `akm upgrade`
// agree on which plugin OpenCode loads: opencode.jsonc before opencode.json, OPENCODE_CONFIG only for OpenCode 1, and
// for OpenCode 1 the first global file that sets the list decides. Unlike akm, a file Desktop cannot read stops the
// check (the plugin shows as unverified) rather than being skipped.
async function openCodePlugin(env, home, major) {
  const directory = env.OPENCODE_CONFIG_DIR?.trim() || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const explicit = major === 2 ? undefined : env.OPENCODE_CONFIG?.trim();
  const files = [explicit, path.join(directory, 'opencode.jsonc'), path.join(directory, 'opencode.json')].filter(Boolean);
  const pkg = major === 2 ? 'akm-opencode-v2' : 'akm-opencode';
  for (const file of files) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const errors = [], config = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || !config || typeof config !== 'object') throw new Error('OpenCode configuration could not be read.');
    let setsList = false;
    for (const key of major === 2 ? ['plugins', 'plugin'] : ['plugin']) {
      if (config[key] !== undefined && !Array.isArray(config[key])) throw new Error('OpenCode plugin configuration is not a list.');
      if (config[key] !== undefined) setsList = true;
      for (const entry of config[key] ?? []) {
        const spec = Array.isArray(entry) ? entry[0] : entry;
        if (typeof spec === 'string' && (spec === pkg || spec.startsWith(pkg + '@'))) return { spec, file };
      }
    }
    if (setsList && file !== explicit && major === 1) return undefined;
  }
  return undefined;
}

function errorMessage(error) {
  if (error instanceof SoftwareError) return error.message;
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'Permission denied. Use the installer that owns this CLI; Desktop will not use sudo.';
  if (error?.killed || error?.code === 'ETIMEDOUT') return 'The command timed out. Check its native status before retrying.';
  return 'The native command did not complete successfully. Check the connection and use the command shown in Details for diagnostics.';
}

/** Host lifecycle only. All upgrades/migration/plugin writes are native commands. */
export class HostTools {
  constructor({ home = os.homedir(), env = process.env, run = runHost, find = findProgram, fetcher = fetch, platform = process.platform } = {}) {
    Object.assign(this, { home, sourceEnv: env, run, find, fetcher, platform });
    this.state = { phase: 'idle', cli: null, harnesses: [], checkedAt: undefined, error: undefined, receipt: undefined };
  }
  snapshot() { return structuredClone(this.state); }
  async environment() { return hostEnvironment(this.sourceEnv, this.home); }
  async invoke(file, args, env, timeout) { return this.run(file, args, { env, home: this.home, timeout }); }
  async detect(name, env) {
    const file = await this.find(name, env);
    if (!file) return { id: name, installed: false };
    try {
      const version = versionOf(await this.invoke(file, ['--version'], env));
      return { id: name, installed: true, path: file, version, runnable: Boolean(version) };
    } catch { return { id: name, installed: true, path: file, runnable: false }; }
  }
  async inventory(env) {
    const cli = await this.detect('akm', env);
    const harnesses = await Promise.all(harnessIds.map(async id => {
      const harness = await this.detect(id, env);
      if (!harness.runnable) return harness;
      try {
        if (id === 'claude') {
          const list = json(await this.invoke(harness.path, ['plugin', 'list', '--json'], env));
          if (!Array.isArray(list)) throw new Error('Unrecognized plugin inventory.');
          const item = list.find(item => item.id === pluginId && (!item.scope || item.scope === 'user'));
          harness.plugin = item ? { state: item.enabled === false ? 'disabled' : 'installed', version: item.version } : { state: 'missing' };
        } else if (id === 'codex') {
          const list = json(await this.invoke(harness.path, ['plugin', 'list', '--marketplace', 'akm-plugins', '--json'], env));
          if (!Array.isArray(list?.installed)) throw new Error('Unrecognized plugin inventory.');
          const item = list.installed.find(item => item.pluginId === pluginId);
          harness.plugin = item ? { state: 'installed', version: item.version, note: 'Review the AKM hooks in Codex /hooks. Installation does not approve them.' } : { state: 'missing' };
        } else {
          const major = Number(harness.version.split('.')[0]);
          if (![1, 2].includes(major)) throw new Error('Unsupported OpenCode major.');
          const configured = await openCodePlugin(env, this.home, major);
          harness.plugin = configured ? { state: 'configured', ...configured, note: 'Restart OpenCode to load this plugin.' } : { state: 'missing' };
          harness.major = major;
        }
      } catch { harness.plugin = { state: 'unknown', note: 'Native inventory could not verify the plugin. Review it in the harness before installing.' }; }
      return harness;
    }));
    Object.assign(this.state, { cli, harnesses });
  }
  start(action, harness, channel = 'latest') {
    if (!['check', 'install-cli', 'upgrade-cli', 'install-plugin'].includes(action) ||
      (action === 'install-plugin' && !harnessIds.includes(harness)) || !['latest', 'next'].includes(channel)) throw new Error('Invalid software action.');
    if (this.pending) throw new Error('A software operation is already running.');
    if (action !== 'check' && process.send) process.send({ type: 'desktop-host-operation', busy: true });
    this.state.phase = action; this.state.error = undefined; this.state.receipt = undefined; this.state.command = undefined;
    this.pending = Promise.resolve().then(async () => {
      const env = await this.environment();
      await this.inventory(env);
      if (action === 'install-cli') await this.installCli(env);
      if (action === 'upgrade-cli') {
        if (!this.state.cli?.runnable) throw new SoftwareError('Install a working CLI first.');
        this.state.command = 'akm upgrade --format json';
        const result = json(await this.invoke(this.state.cli.path, ['upgrade', '--format', 'json'], env, 30 * 60_000));
        // Summarize only lifecycle fields, not complete migration/file payloads.
        this.state.upgrade = summarizeUpgrade(result);
        if (result.migration?.status === 'blocked' || result.migration?.status === 'failed' ||
          result.postUpgrade?.ok === false || result.plugins?.some(item => item.outcome === 'failed'))
          throw new SoftwareError('AKM reported a migration, indexing or plugin failure. Use akm upgrade in your terminal to review its diagnostics.');
        this.state.receipt = 'Native AKM upgrade completed. The bundled desktop engine is unchanged.';
      }
      if (action === 'install-plugin') await this.installPlugin(harness, channel, env);
      await this.inventory(env);
      if (this.state.cli?.runnable) {
        this.state.command = 'akm upgrade --check --format json';
        const result = json(await this.invoke(this.state.cli.path, ['upgrade', '--check', '--format', 'json'], env, 120_000));
        this.state.upgrade = summarizeUpgrade(result);
      }
      this.state.checkedAt = new Date().toISOString();
    }).catch(error => { this.state.error = errorMessage(error); })
      .finally(() => {
        this.state.phase = 'idle'; this.pending = undefined;
        if (action !== 'check' && process.send) process.send({ type: 'desktop-host-operation', busy: false });
      });
    return this.snapshot();
  }
  async installCli(env) {
    if (this.state.cli?.installed) throw new SoftwareError('An existing CLI must be upgraded with its own installer.');
    if (!['linux', 'darwin'].includes(this.platform)) throw new SoftwareError('This build supports host installation on Linux and macOS.');
    // The official installer verifies the release checksum and installs a
    // standalone binary. No Node/Bun prerequisite, npm-global shadow copy or sudo.
    const directory = path.join(this.home, '.local/bin');
    await mkdir(directory, { recursive: true });
    await access(directory, constants.W_OK);
    // Refuse an existing off-PATH binary too; never overwrite an unknown install.
    try { await access(path.join(directory, 'akm')); throw new SoftwareError('A CLI already exists in the install directory. No files were replaced.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const response = await this.fetcher('https://github.com/itlackey/akm/releases/latest/download/install.sh', { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Installer download failed.');
    const text = await response.text();
    if (text.length > 128 * 1024 || !text.startsWith('#!/usr/bin/env bash')) throw new Error('Unexpected installer.');
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'akm-desktop-install-'));
    const file = path.join(temporary, 'install.sh');
    await writeFile(file, text, { mode: 0o600 });
    this.state.command = 'AKM_INSTALL_DIR="$HOME/.local/bin" bash install.sh (official release installer)';
    await this.invoke('/bin/bash', [file], { ...env, AKM_INSTALL_DIR: directory }, 10 * 60_000);
    const installed = await this.detect('akm', env);
    if (!installed.runnable) throw new Error('The installed CLI could not report a version.');
    this.state.receipt = 'AKM CLI installed in ~/.local/bin. Add that directory to your terminal PATH if needed; Desktop already finds it.';
  }
  async installPlugin(id, channel, env) {
    const harness = this.state.harnesses.find(item => item.id === id);
    if (!harness?.runnable || !this.state.cli?.runnable) throw new SoftwareError('Install AKM and the harness first.');
    if (harness.plugin?.state !== 'missing') throw new SoftwareError('The plugin is already present or could not be verified. No change was made.');
    const command = async args => {
      this.state.command = [id, ...args].join(' ');
      await this.invoke(harness.path, args, env, 180_000);
    };
    if (id === 'claude' || id === 'codex') {
      if (!await this.find('bun', env)) throw new SoftwareError('Install Bun first: the AKM hooks use it. No harness configuration was changed.');
      // List first: preserve an existing marketplace's source and release channel.
      const listed = json(await this.invoke(harness.path, ['plugin', 'marketplace', 'list', '--json'], env));
      const list = Array.isArray(listed) ? listed : listed?.marketplaces;
      if (!Array.isArray(list)) throw new Error('Unrecognized marketplace inventory.');
      const exists = list.some(item => (item.name ?? item.marketplaceName) === 'akm-plugins');
      if (!exists) await command(['plugin', 'marketplace', 'add',
        'itlackey/akm-plugins' + (id === 'claude' && channel === 'next' ? '@next' : ''),
        ...(id === 'codex' && channel === 'next' ? ['--ref', 'next'] : [])]);
      await command(id === 'claude'
        ? ['plugin', 'install', pluginId, '--scope', 'user']
        : ['plugin', 'add', pluginId]);
    } else {
      const pkg = harness.major === 2 ? 'akm-opencode-v2' : 'akm-opencode';
      await command(harness.major === 2 ? ['plugin', 'add', `${pkg}@${channel}`] : ['plugin', `${pkg}@${channel}`, '--global']);
    }
    await this.inventory(env);
    const after = this.state.harnesses.find(item => item.id === id)?.plugin;
    if (!['installed', 'configured'].includes(after?.state)) throw new Error('The native installation could not be verified.');
    this.state.receipt = id === 'codex' ? 'AKM installed for Codex. Review its hooks in Codex /hooks to enable automatic recall.'
      : 'AKM plugin installed. Restart the harness to load it.';
  }
}

export function summarizeUpgrade(result) {
  return Object.fromEntries(['currentVersion', 'latestVersion', 'newVersion', 'updateAvailable', 'upgraded', 'installMethod', 'channel',
    'currentChannel', 'targetChannel'].filter(key => ['string', 'boolean'].includes(typeof result?.[key])).map(key => [key, result[key]]));
}
