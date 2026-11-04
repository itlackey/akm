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

/** Re-key every draft of a renamed bundle, so it still opens the same document. */
export function renameBundle(oldName: string, name: string) {
  try {
    const from = `${PREFIX}${oldName}/`;
    for (const key of Object.keys(sessionStorage).filter((key) => key.startsWith(from))) {
      const draft = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (draft?.bundle === oldName) draft.bundle = name;
      sessionStorage.setItem(`${PREFIX}${name}/${key.slice(from.length)}`, JSON.stringify(draft));
      sessionStorage.removeItem(key);
    }
  } catch {
    /* existing drafts remain available */
  }
}
