// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { draftKey, readDraft, renameBundle, storeDraft } from "../src/lib/drafts.ts";

// Session storage as the browser exposes it: stored keys are the object's own keys.
const storage = Object.create({
  getItem(key) {
    return Object.hasOwn(this, key) ? this[key] : null;
  },
  setItem(key, value) {
    this[key] = String(value);
  },
  removeItem(key) {
    delete this[key];
  },
});
Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });

test("a bundle rename re-keys its file and ref drafts and retargets every draft that saves into it", () => {
  const draft = (bundle) => ({ draft: "text", bundle, name: "note", folder: "knowledge" });
  const file = draftKey({ file: { bundle: "work", path: "knowledge/note.md" } });
  const ref = draftKey({ ref: "work//knowledge/note" });
  const created = draftKey({});
  const other = draftKey({ ref: "work-archive//knowledge/note" });
  storeDraft(file, draft("work"));
  storeDraft(ref, draft("work"));
  storeDraft(created, draft("work"));
  storeDraft(other, draft("work-archive"));

  renameBundle("work", "team");

  assert.equal(readDraft(file), null);
  assert.equal(readDraft(ref), null);
  assert.equal(readDraft(draftKey({ file: { bundle: "team", path: "knowledge/note.md" } }))?.bundle, "team");
  assert.equal(readDraft(draftKey({ ref: "team//knowledge/note" }))?.bundle, "team");
  // The new document keeps its key; it now saves into the renamed bundle.
  assert.equal(readDraft(created)?.bundle, "team");
  assert.equal(readDraft(other)?.bundle, "work-archive");
});
