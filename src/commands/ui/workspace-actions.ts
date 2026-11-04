// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The explicit workspace actions behind `akm ui`: a table from path to the workspace operation it performs
 * (`src/workspace/*` owns the behaviour). Each entry only turns a JSON body into that operation's input.
 * Frozen with the rest of `akm ui`.
 */

import { UsageError } from "../../core/errors";
import { bundles, config, documents, feedback } from "../../workspace";

export type WorkspaceAction =
  | "feedback"
  | "bundle-add"
  | "bundle-remove"
  | "bundle-update"
  | "bundle-rename"
  | "bundle-settings"
  | "config-set"
  | "document-save"
  | "document-retire"
  | "knowledge-create";

const ROUTES: Record<string, WorkspaceAction> = {
  "/api/feedback": "feedback",
  "/api/bundles/add": "bundle-add",
  "/api/bundles/remove": "bundle-remove",
  "/api/bundles/update": "bundle-update",
  "/api/bundles/rename": "bundle-rename",
  "/api/bundles/settings": "bundle-settings",
  "/api/config/set": "config-set",
  "/api/knowledge/create": "knowledge-create",
  "/api/asset/save": "document-save",
  "/api/asset/retire": "document-retire",
};

export function matchWorkspaceAction(path: string): WorkspaceAction | null {
  return ROUTES[path] ?? null;
}

/** The body as the operation's input: a JSON object. The operation owns what its fields must be. */
function input<T>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError("A JSON object is required.");
  return value as T;
}

/** The wire carries a typed fix as two parallel lists; the operation takes pairs. */
function fixPairs(body: object) {
  const { replace, with: replacement } = body as { replace?: unknown; with?: unknown };
  if (replace === undefined && replacement === undefined) return undefined;
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!strings(replace) || !strings(replacement) || replace.length === 0 || replace.length !== replacement.length)
    throw new UsageError("replace and with must be lists of the same length.");
  return replace.map((old, i) => ({ replace: old, with: replacement[i] as string }));
}

export async function handleWorkspaceAction(action: WorkspaceAction, body: unknown): Promise<unknown> {
  switch (action) {
    case "feedback": {
      const value = input<Omit<feedback.FeedbackInput, "fix">>(body);
      return feedback.record({ ...value, fix: fixPairs(value) });
    }
    case "bundle-add":
      return bundles.add(input(body));
    case "bundle-remove":
      return bundles.remove(input(body));
    case "bundle-update":
      return bundles.update(input(body));
    case "bundle-rename":
      return bundles.rename(input(body));
    case "bundle-settings":
      return bundles.setSettings(input(body));
    case "config-set":
      return config.change(input(body));
    case "document-retire":
      return documents.retire(input(body));
    case "document-save":
      return documents.save(input(body));
    case "knowledge-create":
      return documents.createKnowledge(input(body));
  }
}
