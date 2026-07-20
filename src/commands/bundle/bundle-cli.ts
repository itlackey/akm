// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle` command family (normative spec §29 CLI convergence). Groups the
 * 0.9.0 read verbs over the workspace bundle state:
 *
 *   akm bundle list          — configured bundles + resolved lock state
 *   akm bundle show <id>     — one bundle's config, lock state, item count
 *   akm bundle items <id>    — a bundle's indexed items (by canonical ref)
 *
 * Mirrors the existing group-command wiring (`graph`, `env`, `secret`): a
 * `defineGroupCommand` whose `defaultRun` fires only on the bare `akm bundle`
 * invocation (falls back to `list`), and `defineJsonCommand` leaves that emit
 * the standard JSON envelope with `--format` parity. The lifecycle verbs
 * (`create`/`install`/`update`/`remove`/`sync`/`export`) stay on their existing
 * top-level commands for 0.9.0; `bind`/`unbind`/`bindings` are Tier B and are
 * intentionally not registered here (spec §18 staging note, §29).
 */

import { defineGroupCommand, defineJsonCommand, output } from "../../cli/shared";
import { akmBundleItems, akmBundleList, akmBundleShow } from "./bundle";

const bundleSubCommands = {
  list: defineJsonCommand({
    meta: {
      name: "list",
      description: "List configured bundles (desired config + resolved lock state), defaultBundle marked",
    },
    run() {
      output("bundle-list", akmBundleList());
    },
  }),
  show: defineJsonCommand({
    meta: {
      name: "show",
      description: "Show one bundle's source descriptor, resolved lock state, components, and item count",
    },
    args: {
      // Optional in citty so run() is invoked even when omitted; the body then
      // throws a structured UsageError (exit 2) instead of citty's raw
      // required-positional error (which escapes as an unclassified exit 70).
      id: { type: "positional", description: "Bundle id (a key in the workspace `bundles` config)", required: false },
    },
    run({ args }) {
      output("bundle-show", akmBundleShow({ id: typeof args.id === "string" ? args.id : "" }));
    },
  }),
  items: defineJsonCommand({
    meta: {
      name: "items",
      description: "List a bundle's indexed items by canonical `bundle//conceptId` ref, with a per-type count",
    },
    args: {
      // Optional for the same reason as `show` above: a missing id must surface
      // as a structured UsageError (exit 2), not citty's unclassified exit 70.
      id: { type: "positional", description: "Bundle id (a key in the workspace `bundles` config)", required: false },
    },
    run({ args }) {
      output("bundle-items", akmBundleItems({ id: typeof args.id === "string" ? args.id : "" }));
    },
  }),
};

export const bundleCommand = defineGroupCommand({
  meta: { name: "bundle", description: "Inspect the workspace's configured bundles and their resolved lock state" },
  subCommands: bundleSubCommands,
  defaultRun() {
    output("bundle-list", akmBundleList());
  },
});
