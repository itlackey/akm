// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { directoryKey, type FileListing } from "./library-files-model";
import { libraryRead } from "./library-model";

/**
 * The folders of the tree that have been read, which are open, and which are being read. Files and the folder picker
 * each hold one; a folder is read from akm one directory at a time.
 */
export class FileTreeState {
  listings = $state(new Map<string, FileListing>());
  expanded = $state(new Set<string>());
  loading = $state(new Set<string>());
  errors = $state(new Map<string, string>());
  showHidden = false;
  private requests = new Map<string, Promise<void>>();
  private generation = 0;
  private controller = new AbortController();

  constructor(kept?: { listings?: Map<string, FileListing>; expanded?: Set<string>; showHidden?: boolean }) {
    if (kept?.listings) this.listings = kept.listings;
    if (kept?.expanded) this.expanded = kept.expanded;
    this.showHidden = kept?.showHidden ?? false;
  }

  /** Read one folder; `force` reads it again. Failures are kept with their reason, per folder. */
  load(bundle: string, directory: string, force = false): Promise<void> {
    const id = directoryKey(bundle, directory);
    const running = this.requests.get(id);
    if (running) return running;
    if (!force && this.listings.has(id)) return Promise.resolve();
    const generation = this.generation,
      signal = this.controller.signal;
    this.loading = new Set([...this.loading, id]);
    this.errors.delete(id);
    this.errors = new Map(this.errors);
    const request = (async () => {
      try {
        const result = await libraryRead<FileListing>(
          "/bundles/files",
          { bundle, path: directory, ...(this.showHidden ? { hidden: "1" } : {}) },
          signal,
        );
        if (signal.aborted || generation !== this.generation) return;
        this.listings = new Map(this.listings).set(id, result);
      } catch (cause) {
        if (!signal.aborted && generation === this.generation)
          this.errors = new Map(this.errors).set(id, (cause as Error).message);
      } finally {
        if (generation === this.generation) {
          this.loading.delete(id);
          this.loading = new Set(this.loading);
          this.requests.delete(id);
        }
      }
    })();
    this.requests.set(id, request);
    return request;
  }

  open(key: string, bundle: string, directory: string) {
    this.expanded = new Set([...this.expanded, key]);
    return this.load(bundle, directory);
  }

  async toggle(key: string, bundle: string, directory: string) {
    const next = new Set(this.expanded);
    if (!next.delete(key)) next.add(key);
    this.expanded = next;
    if (next.has(key)) await this.load(bundle, directory);
  }

  /** The folders already opened are read again; nothing new is enumerated. */
  invalidate() {
    const open = [...this.listings.values()].filter((listing) =>
      this.expanded.has(directoryKey(listing.bundle, listing.path)),
    );
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.requests = new Map();
    this.listings = new Map();
    this.errors = new Map();
    this.loading = new Set();
    return Promise.all(open.map((listing) => this.load(listing.bundle, listing.path)));
  }

  abort() {
    this.controller.abort();
  }
}
