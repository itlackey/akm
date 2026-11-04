import { randomUUID } from 'node:crypto';
import { HostTools } from './host-tools.mjs';

export const hostTools = new HostTools();
const pending = new Map();
process.on('message', message => {
  if (message?.type !== 'desktop-update-response') return;
  const item = pending.get(message.id);
  if (!item) return;
  clearTimeout(item.timer); pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error)); else item.resolve(message.data);
});
export function desktopUpdate(action = 'status', value) {
  if (!process.send || process.env.AKM_DESKTOP_NATIVE_UPDATES !== '1') {
    if (action === 'menu-install') return Promise.reject(new Error('Menu installation is available in the Linux AppImage.'));
    return Promise.resolve({ supported: false, phase: 'idle', reason: 'Open the packaged desktop app to manage its updates and application menu entry.',
      menu: { supported: false, installed: false, busy: false },
      settings: { automatic: true, authenticated: false, remembered: false, canRemember: false } });
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop update service did not respond.')); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    process.send({ type: 'desktop-update-request', id, action, value });
  });
}
