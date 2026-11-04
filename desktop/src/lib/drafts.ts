// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Editor drafts: the stored copy in sessionStorage, keyed by the document, and the in-memory "unsaved" flag. */
const PREFIX = "akm-desktop-editor:";

let unsaved = false;
/** The editor marks a draft that leaving the page would lose; the navigation guard asks before discarding it. */
export function setUnsaved(value: boolean) {
  unsaved = value;
}
export function hasUnsaved() {
  return unsaved;
}

export interface Draft {
  draft: string;
  bundle: string;
  name: string;
  folder: string;
  baseRevision?: string;
  baseContent?: string;
}

/** A draft belongs to a bundle file, an asset ref, or the one new document. */
export function draftKey(target: { file?: { bundle: string; path: string }; ref?: string }): string {
  return PREFIX + (target.file ? `${target.file.bundle}/${target.file.path}` : target.ref || "new");
}

/** Storage may be unavailable; the draft then stays in memory only. */
export function storeDraft(key: string, draft: Draft) {
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    /* draft remains in memory */
  }
}

export function readDraft(key: string): Partial<Draft> | null {
  try {
    const saved = sessionStorage.getItem(key);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

export function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* the successful write is authoritative */
  }
}

/** Any stored draft means a reload or close would lose work. */
export function hasStoredDrafts(): boolean {
  try {
    return Object.keys(sessionStorage).some((key) => key.startsWith(PREFIX));
  } catch {
    return false;
  }
}

/**
 * Follow a renamed bundle: a draft that targets it (including the new document's) saves to the new name, and a draft
 * keyed by one of its files or refs is re-keyed, so it still opens the same document.
 */
export function renameBundle(oldName: string, name: string) {
  try {
    const from = `${PREFIX}${oldName}/`;
    for (const key of Object.keys(sessionStorage).filter((key) => key.startsWith(PREFIX))) {
      const draft = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (draft?.bundle === oldName) draft.bundle = name;
      const next = key.startsWith(from) ? `${PREFIX}${name}/${key.slice(from.length)}` : key;
      sessionStorage.setItem(next, JSON.stringify(draft));
      if (next !== key) sessionStorage.removeItem(key);
    }
  } catch {
    /* existing drafts remain available */
  }
}
