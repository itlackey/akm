// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { addToast, removeToast, type Toast, type ToastInput } from "../toast-model";

/** Nonblocking feedback any view can raise: `showToast({ title: "Accepted restore laptop" })`. `Toasts.svelte` shows and announces them. */
export const toasts = $state({ items: [] as Toast[] });

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function arm(toast: Toast) {
  clearTimeout(timers.get(toast.id));
  timers.delete(toast.id);
  if (toast.timeoutMs !== null)
    timers.set(
      toast.id,
      setTimeout(() => dismissToast(toast.id), toast.timeoutMs),
    );
}

export function showToast(input: ToastInput): number {
  const id = nextId++;
  toasts.items = addToast(toasts.items, input, id);
  for (const t of toasts.items) if (t.id === id) arm(t);
  // A replaced or dropped toast has no timer left to fire.
  for (const key of [...timers.keys()]) if (!toasts.items.some((t) => t.id === key)) timers.delete(key);
  return id;
}

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts.items = removeToast(toasts.items, id);
}

/** Reading or reaching for a toast holds its timer; letting go starts the full time again. */
export function holdToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}
export function releaseToast(id: number) {
  const toast = toasts.items.find((t) => t.id === id);
  if (toast) arm(toast);
}
