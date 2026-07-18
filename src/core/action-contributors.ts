// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defaultRendererRegistry, type RendererRegistry } from "./type-presentation";

export interface ActionContext {
  type: string;
  ref: string;
}

export interface ActionContributor {
  name: string;
  appliesTo(ctx: ActionContext): boolean;
  buildAction(ctx: ActionContext): string | undefined;
}

function registryActionContributor(registry: RendererRegistry): ActionContributor {
  return {
    name: "registry-action-contributor",
    appliesTo(ctx) {
      return registry.actionBuilderFor(ctx.type) !== undefined;
    },
    buildAction(ctx) {
      return registry.actionBuilderFor(ctx.type)?.(ctx.ref);
    },
  };
}

export function defaultActionContributors(registry: RendererRegistry = defaultRendererRegistry): ActionContributor[] {
  return [registryActionContributor(registry)];
}

export function buildActionFromContributors(
  ctx: ActionContext,
  contributors: ActionContributor[] = defaultActionContributors(),
): string | undefined {
  for (const contributor of contributors) {
    if (!contributor.appliesTo(ctx)) continue;
    const action = contributor.buildAction(ctx);
    if (action !== undefined) return action;
  }
  return undefined;
}
