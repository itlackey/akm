// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `@clack/prompts` seam — the single src-side binding for the prompt surface.
 *
 * All src code imports the clack prompt API from this module (never from
 * `@clack/prompts` directly), so tests can swap the interactive surface via
 * `_setClackForTests` instead of `mock.module` — the same third-party seam
 * pattern as the `@huggingface/transformers` loader in
 * `src/llm/embedders/local.ts`. Production behavior is byte-identical: every
 * export delegates to the real package unless a test installed a fake.
 *
 * See docs/design/di-seams-plan.md.
 */

import type * as clack from "@clack/prompts";
import {
  cancel as realCancel,
  confirm as realConfirm,
  intro as realIntro,
  isCancel as realIsCancel,
  log as realLog,
  multiselect as realMultiselect,
  note as realNote,
  outro as realOutro,
  select as realSelect,
  spinner as realSpinner,
  text as realText,
} from "@clack/prompts";

type Clack = typeof clack;

type FakeFn = (...args: never[]) => unknown;

/**
 * The subset of the clack surface a test fake may replace. Deliberately
 * loosely typed (like `mock.module` was): fakes replace runtime behavior
 * without reproducing clack's generic signatures. Members left undefined
 * fall through to the real implementation.
 */
export interface ClackFakeForTests {
  intro?: FakeFn;
  outro?: FakeFn;
  cancel?: FakeFn;
  confirm?: FakeFn;
  select?: FakeFn;
  multiselect?: FakeFn;
  text?: FakeFn;
  spinner?: FakeFn;
  note?: FakeFn;
  isCancel?: (value: unknown) => boolean;
  log?: Partial<Record<keyof Clack["log"], FakeFn>>;
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter
// (via tests/_helpers/seams.ts `overrideSeam`, never directly).
let clackFake: ClackFakeForTests | undefined;

/** TEST-ONLY. Swap the clack prompt surface; pass undefined to restore. */
export function _setClackForTests(fake?: ClackFakeForTests): void {
  clackFake = fake;
}

const realFns = {
  intro: realIntro,
  outro: realOutro,
  cancel: realCancel,
  confirm: realConfirm,
  select: realSelect,
  multiselect: realMultiselect,
  text: realText,
  spinner: realSpinner,
  note: realNote,
  isCancel: realIsCancel,
} as const;

/** Delegator with the real export's exact type; reads the fake at call time. */
function bind<K extends keyof typeof realFns>(name: K): Clack[K] {
  return ((...args: unknown[]) => {
    const impl = (clackFake?.[name] ?? realFns[name]) as (...a: unknown[]) => unknown;
    return impl(...args);
  }) as Clack[K];
}

function bindLog<K extends keyof Clack["log"]>(name: K): Clack["log"][K] {
  return ((...args: unknown[]) => {
    const impl = (clackFake?.log?.[name] ?? realLog[name]) as (...a: unknown[]) => unknown;
    return impl(...args);
  }) as Clack["log"][K];
}

export const intro = bind("intro");
export const outro = bind("outro");
export const cancel = bind("cancel");
export const confirm = bind("confirm");
export const select = bind("select");
export const multiselect = bind("multiselect");
export const text = bind("text");
export const spinner = bind("spinner");
export const note = bind("note");
export const isCancel = bind("isCancel");

export const log: Clack["log"] = {
  message: bindLog("message"),
  info: bindLog("info"),
  success: bindLog("success"),
  step: bindLog("step"),
  warn: bindLog("warn"),
  warning: bindLog("warning"),
  error: bindLog("error"),
};
