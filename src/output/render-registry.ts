// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-command `md` renderer registry (D7).
 *
 * Mirrors `src/output/text/registry.ts`: a command may register a bespoke
 * Markdown renderer, and anything unregistered falls back to the generic
 * rendering of its shaped envelope (`./generic-render`). The fallback is what
 * makes all six `--format` values universal; the registry is what lets a
 * command that has something better to say — `akm health` and its report
 * tables — say it without the output pipeline knowing that command exists.
 *
 * Kept separate from the module that dispatches through it so per-command
 * renderer modules can import `registerMdRenderer` without a cycle back into
 * the pipeline, exactly as the text registry does.
 *
 * Returning `null` from a handler means "I have nothing special for this
 * payload" and falls through to the generic renderer — `akm health` uses that
 * to keep its bespoke tables for the shapes that have them while still
 * rendering everything else.
 *
 * A plain `Map`, not the shared `createCommandRegistry` factory: unlike the
 * text/shape registries (dozens of commands, assembled in bulk via
 * `registerAll`), `akm health` is the only caller this one ever holds, and
 * only `register`/`get` are used.
 *
 * `--format html` has no such registry: `akm health` is, and has only ever
 * been, its one bespoke HTML renderer, so `cli/shared.ts` calls
 * `renderHealthHtml` (`../commands/health/renderers.ts`) directly instead of
 * looking it up through a registry with exactly one possible registrant.
 */

import type { DetailLevel } from "./context";

/**
 * Handler signature for a registered document-format renderer.
 *
 * Return a rendered string, or `null` to fall through to the generic renderer.
 */
export type DocumentRendererHandler = (result: unknown, detail: DetailLevel) => string | null;

const mdRenderers = new Map<string, DocumentRendererHandler>();

/** Register a Markdown renderer for a command name. */
export function registerMdRenderer(command: string, handler: DocumentRendererHandler): void {
  mdRenderers.set(command, handler);
}

/** Look up a registered Markdown renderer, or `undefined` when unregistered. */
export function getMdRendererHandler(command: string): DocumentRendererHandler | undefined {
  return mdRenderers.get(command);
}
