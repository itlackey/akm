// Adapted from fwdslsh/fhold admin-desktop.ts (MIT); see THIRD_PARTY.md.
import { copyFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const DESKTOP_ID = 'dev.fwdslsh.akm-desktop';

function escapeValue(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
}

export function desktopEntry(appImage) {
  // String decoding precedes Exec quoting. There is no shell or URL/file input.
  if (!isAbsolute(appImage) || appImage.includes('=')) throw new Error('The menu executable needs an absolute path without an equals sign.');
  const argument = escapeValue(`"${appImage.replaceAll('%', '%%').replace(/(["`$\\])/g, '\\$1')}"`);
  return `[Desktop Entry]\nVersion=1.0\nType=Application\nName=AKM Desktop\nComment=Browse and maintain your agent knowledge\nExec=${argument}\nIcon=${DESKTOP_ID}\nTerminal=false\nCategories=Utility;\nStartupNotify=true\nStartupWMClass=${DESKTOP_ID}\n`;
}

/** Explicit per-user installation; no sudo, shell launcher, AKM data or startup writes. */
export class DesktopMenu {
  constructor(environment) {
    this.environment = environment;
    const data = environment.dataHome && isAbsolute(environment.dataHome)
      ? environment.dataHome : join(environment.home, '.local/share');
    this.paths = {
      appImage: join(environment.home, '.local/bin/akm-desktop.AppImage'),
      entry: join(data, `applications/${DESKTOP_ID}.desktop`),
      icon: join(data, `icons/hicolor/512x512/apps/${DESKTOP_ID}.png`)
    };
  }
  async status() {
    const env = this.environment;
    const supported = env.platform === 'linux' && env.packaged && Boolean(env.appImage && isAbsolute(env.appImage));
    const runningInstalledCopy = supported && resolve(env.appImage) === resolve(this.paths.appImage);
    const [entry, image, icon] = await Promise.all([
      readFile(this.paths.entry, 'utf8').catch(() => ''),
      stat(this.paths.appImage).catch(() => undefined),
      stat(this.paths.icon).catch(() => undefined)
    ]);
    return {
      supported, busy: Boolean(this.pending), runningInstalledCopy,
      installed: Boolean(image?.isFile() && (image.mode & 0o111) && icon?.isFile() && entry === desktopEntry(this.paths.appImage)),
      // A download can be older than the installed/self-updated copy. Never guess.
      replacesExistingCopy: Boolean(image?.isFile() && !runningInstalledCopy),
      appImage: this.paths.appImage
    };
  }
  busy() { return Boolean(this.pending); }
  install(confirmReplacement = async () => false) {
    this.pending ??= this.performInstall(confirmReplacement).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async performInstall(confirmReplacement) {
    const status = await this.status();
    if (!status.supported) throw new Error('Menu installation is available in the Linux AppImage.');
    if (status.replacesExistingCopy && !(await confirmReplacement())) return status;
    const icon = await readFile(this.environment.icon);
    const entry = desktopEntry(this.paths.appImage);
    const staged = [];
    const stage = async (destination, mode, write) => {
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      staged.push({ temporary, destination });
      await write(temporary);
      await chmod(temporary, mode);
    };
    try {
      if (!status.runningInstalledCopy)
        await stage(this.paths.appImage, 0o755, temporary => copyFile(this.environment.appImage, temporary));
      await stage(this.paths.icon, 0o644, temporary => writeFile(temporary, icon, { flag: 'wx' }));
      await stage(this.paths.entry, 0o644, temporary => writeFile(temporary, entry, { flag: 'wx' }));
      // Do not publish a menu entry before its executable and icon are ready.
      for (const { temporary, destination } of staged) await rename(temporary, destination);
    } finally {
      await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
    }
    return this.status();
  }
}
