// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Toasts as plain data: what is shown, for how long, and which live region announces it. The timers and state are `state/toasts.svelte.ts`. */

export type ToastKind = "success" | "info" | "warning" | "error";
export interface ToastInput {
  kind?: ToastKind;
  /** One line that says what happened and to what, since the toast may outlive the screen that caused it. */
  title: string;
  detail?: string;
  /** A second chance tied to the thing the toast reports (Undo, Reopen, View). Runs on click; the toast closes after it. */
  action?: { label: string; run: () => void | Promise<void> };
  /** A toast with a key replaces the one already showing under it, so a repeated event does not stack. */
  key?: string;
  /** Milliseconds before it closes itself; `null` stays until dismissed. Default: success and info close, warning and error stay. */
  timeoutMs?: number | null;
}
export interface Toast extends Required<Pick<ToastInput, "title" | "kind">> {
  id: number;
  detail?: string;
  action?: ToastInput["action"];
  key?: string;
  timeoutMs: number | null;
}

export const TOAST_MS = 6000;
/** A toast with an action stays longer, so there is time to reach it. */
export const TOAST_ACTION_MS = 10000;
/** Pause after the pointer or focus leaves a toast before its timer starts again. */
export const TOAST_RESUME_MS = 2000;
/** At most this many show at once: a new one drops the oldest self-closing toast; warnings and errors are never dropped. */
export const TOAST_MAX = 3;

/** Success and info are announced politely; warnings and errors interrupt, because the reviewer has to act on them. */
export const toastRole = (kind: ToastKind): "status" | "alert" =>
  kind === "error" || kind === "warning" ? "alert" : "status";

export function addToast(list: Toast[], input: ToastInput, id: number): Toast[] {
  const kind = input.kind ?? "success";
  const toast: Toast = {
    id,
    kind,
    title: input.title,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.key ? { key: input.key } : {}),
    timeoutMs:
      input.timeoutMs !== undefined
        ? input.timeoutMs
        : kind === "success" || kind === "info"
          ? input.action
            ? TOAST_ACTION_MS
            : TOAST_MS
          : null,
  };
  const next = [...list.filter((t) => !input.key || t.key !== input.key), toast];
  while (next.length > TOAST_MAX) {
    const drop = next.findIndex((t) => t.timeoutMs !== null && t.id !== id);
    if (drop < 0) break;
    next.splice(drop, 1);
  }
  return next;
}

export const removeToast = (list: Toast[], id: number): Toast[] => list.filter((t) => t.id !== id);
