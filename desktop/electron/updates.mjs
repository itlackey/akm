import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const RELEASE_REPOSITORY = 'https://code.lab.fwdslsh.dev/fwdslsh/akm-desktop';
export const UPDATE_INTERVAL = 4 * 60 * 60 * 1000;

// The encrypted credential belongs to Electron's main process, never AKM's
// settings, the renderer, the server environment or a distributed artifact.
export class UpdateSettings {
  constructor(directory, encryption) {
    this.file = path.join(directory, 'updates.json');
    this.encryption = encryption;
    this.automatic = true;
    this.token = '';
    this.encryptedToken = undefined;
  }
  canRemember() {
    return this.encryption.isEncryptionAvailable() &&
      this.encryption.getSelectedStorageBackend?.() !== 'basic_text';
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.automatic = data.automatic !== false;
      if (typeof data.encryptedToken === 'string') {
        this.encryptedToken = data.encryptedToken;
        this.token = this.encryption.decryptString(Buffer.from(data.encryptedToken, 'base64'));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = 'Update settings could not be opened. Re-enter the repository token.';
    }
  }
  snapshot() {
    return { automatic: this.automatic, authenticated: Boolean(this.token), remembered: Boolean(this.encryptedToken),
      canRemember: this.canRemember(), error: this.error };
  }
  async save(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['automatic', 'token', 'remember'].includes(key)) ||
      (value.automatic !== undefined && typeof value.automatic !== 'boolean') ||
      (value.token !== undefined && (typeof value.token !== 'string' || /[\r\n]/.test(value.token) || value.token.length > 4096)) ||
      (value.remember !== undefined && typeof value.remember !== 'boolean')) throw new Error('Invalid update preferences.');
    const token = value.token === undefined ? this.token : value.token.trim();
    if (value.token === undefined && !token && this.encryptedToken) throw new Error('Unlock your keyring or re-enter the token before saving update preferences.');
    const remember = value.remember ?? Boolean(this.encryptedToken);
    if (remember && token && !this.canRemember()) throw new Error('A system keyring is required to remember the token. Use it for this session instead.');
    const encryptedToken = remember && token ? this.encryption.encryptString(token).toString('base64') : undefined;
    const automatic = value.automatic ?? this.automatic;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ automatic, encryptedToken }) + '\n', { mode: 0o600 });
    await rename(temporary, this.file);
    Object.assign(this, { automatic, token, encryptedToken, error: undefined });
    return this.snapshot();
  }
}

function updateError(error) {
  const message = String(error?.message ?? error);
  if (/401|403|404/.test(message)) return 'No accessible desktop release. Check the read-only repository token and whether a release has been published.';
  if (/sha512|checksum/i.test(message)) return 'The update failed integrity verification. It was not installed.';
  if (/EACCES|EPERM/.test(message)) return 'The AppImage cannot be replaced. Move it to a folder you own and try again.';
  return 'The desktop update could not complete. Check the connection and retry.';
}

// electron-updater owns version comparison, checksums, downloads and replacing
// the AppImage. Gitea only resolves the private release's generic feed URL.
export class DesktopUpdates {
  constructor({ version, store, createUpdater, fetchRelease = fetch, supported = true }) {
    Object.assign(this, { store, createUpdater, fetchRelease });
    this.state = { version, supported, phase: 'idle', repository: RELEASE_REPOSITORY,
      ...(!supported ? { reason: 'Automatic installation is available in the Linux AppImage build.' } : {}) };
  }
  snapshot() { return { ...this.state, settings: this.store.snapshot() }; }
  native() {
    if (this.updater) return this.updater;
    const updater = this.createUpdater();
    updater.logger = null; // Native errors may contain the authenticated request.
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    // Main process coordinates shutdown before installing; never race server writes.
    updater.autoInstallOnAppQuit = false;
    updater.on('update-available', info => Object.assign(this.state, { phase: 'downloading', availableVersion: info.version }));
    updater.on('update-not-available', () => Object.assign(this.state, { phase: 'current', availableVersion: undefined }));
    updater.on('download-progress', info => Object.assign(this.state, { phase: 'downloading', progress: Math.round(info.percent) }));
    updater.on('update-downloaded', info => Object.assign(this.state, { phase: 'ready', availableVersion: info.version, progress: undefined, error: undefined }));
    updater.on('error', error => Object.assign(this.state, { phase: 'error', progress: undefined, error: updateError(error) }));
    this.updater = updater;
    return updater;
  }
  check() {
    if (this.pending) return this.pending;
    if (!this.state.supported || this.state.phase === 'ready') return Promise.resolve(this.snapshot());
    if (!this.store.token) {
      this.state.error = 'Connect the private repository with a read-only token to receive updates.';
      return Promise.resolve(this.snapshot());
    }
    this.state.phase = 'checking'; this.state.error = undefined;
    this.pending = Promise.resolve().then(async () => {
      const headers = { Authorization: `token ${this.store.token}`, Accept: 'application/json' };
      const response = await this.fetchRelease('https://code.lab.fwdslsh.dev/api/v1/repos/fwdslsh/akm-desktop/releases/latest',
        { headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (!response.ok) throw new Error(`Release lookup: ${response.status}`);
      const release = await response.json();
      if (!/^v?0\.0\.\d+$/.test(release.tag_name) || release.draft || release.prerelease) throw new Error('Invalid private release.');
      if (!release.assets?.some(asset => asset.name === (process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml')))
        throw new Error('Release is missing its update manifest.');
      const updater = this.native();
      updater.autoDownload = true;
      updater.requestHeaders = headers;
      updater.setFeedURL({ provider: 'generic', url: `${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/`,
        useMultipleRangeRequest: false });
      updater.allowDowngrade = false;
      const result = await updater.checkForUpdates();
      await result?.downloadPromise;
      this.state.checkedAt = new Date().toISOString();
    }).catch(error => Object.assign(this.state, { phase: 'error', progress: undefined, error: updateError(error) }))
      .then(() => this.snapshot()).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async save(value) {
    if (this.pending || this.state.phase === 'ready') throw new Error('Finish the current update before changing its settings.');
    await this.store.save(value);
    this.state.error = undefined;
    if (this.store.automatic && this.store.token) void this.check();
    return this.snapshot();
  }
  start() {
    if (this.timer || !this.state.supported) return;
    const check = () => { if (this.store.automatic && this.store.token) void this.check(); };
    check(); this.timer = setInterval(check, UPDATE_INTERVAL); this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = undefined; }
  installOnQuit() {
    if (this.state.phase !== 'ready') return false;
    this.state.phase = 'installing';
    this.updater.quitAndInstall(true, false);
    return this.state.phase === 'installing';
  }
}
