// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { addToast, removeToast, TOAST_ACTION_MS, TOAST_MAX, TOAST_MS, toastRole } from "../src/lib/toast-model.ts";

test("success and info close themselves; warnings and errors stay until dismissed", () => {
  const list = ["success", "info", "warning"].reduce((all, kind, i) => addToast(all, { kind, title: kind }, i + 1), []);
  assert.deepEqual(
    list.map((t) => t.timeoutMs),
    [TOAST_MS, TOAST_MS, null],
  );
  assert.equal(addToast([], { kind: "error", title: "x" }, 1)[0].timeoutMs, null);
  assert.equal(addToast([], { title: "Accepted x" }, 1)[0].kind, "success", "success is the default");
  assert.equal(addToast([], { kind: "error", title: "x", timeoutMs: 100 }, 1)[0].timeoutMs, 100);
  assert.equal(addToast([], { title: "x", timeoutMs: null }, 1)[0].timeoutMs, null);
});

test("errors and warnings are announced assertively, the rest politely", () => {
  assert.deepEqual(["success", "info", "warning", "error"].map(toastRole), ["status", "status", "alert", "alert"]);
});

test("a key replaces its toast, and removal is by id", () => {
  let list = addToast([], { title: "Accepted a", key: "decision" }, 1);
  list = addToast(list, { title: "Accepted b", key: "decision" }, 2);
  assert.deepEqual(
    list.map((t) => t.title),
    ["Accepted b"],
  );
  list = addToast(list, { title: "Other" }, 3);
  assert.deepEqual(
    removeToast(list, 2).map((t) => t.id),
    [3],
  );
});

test("a full stack drops the oldest self-closing toast first and never a warning or error", () => {
  let list = addToast([], { kind: "error", title: "keep" }, 1);
  for (let id = 2; id <= TOAST_MAX + 1; id++) list = addToast(list, { title: `t${id}` }, id);
  assert.equal(list.length, TOAST_MAX);
  assert.ok(
    list.some((t) => t.id === 1),
    "the error stays",
  );
  assert.ok(!list.some((t) => t.id === 2), "the oldest success went");
  let urgent = [];
  for (let id = 1; id <= TOAST_MAX + 1; id++) urgent = addToast(urgent, { kind: "error", title: `e${id}` }, id);
  assert.equal(urgent.length, TOAST_MAX + 1, "errors that need action are all kept");
});

test("a toast with an action stays longer", () => {
  assert.equal(addToast([], { title: "x", action: { label: "Undo", run() {} } }, 1)[0].timeoutMs, TOAST_ACTION_MS);
});

test("an action travels with the toast", () => {
  const run = () => {};
  const [toast] = addToast([], { title: "Accepted", action: { label: "Undo", run } }, 1);
  assert.equal(toast.action.label, "Undo");
  assert.equal(toast.action.run, run);
});
