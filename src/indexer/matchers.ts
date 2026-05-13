/**
 * Built-in asset matchers for the akm file classification system.
 *
 * Classification facts now live in `match-contributors.ts`. This module keeps
 * the existing matcher API and registration order intact by adapting those
 * facts back into `MatchResult` values.
 */

import { defaultRendererRegistry } from "../core/asset-registry";
import type { AssetMatcher, FileContext, MatchResult } from "./file-context";
import { registerMatcher } from "./file-context";
import {
  directoryContributor,
  extensionContributor,
  parentDirHintContributor,
  smartMdContributor,
  wikiContributor,
} from "./match-contributors";

type MatcherContributor =
  | typeof extensionContributor
  | typeof directoryContributor
  | typeof parentDirHintContributor
  | typeof smartMdContributor
  | typeof wikiContributor;

function toMatchResult(ctx: FileContext, contributor: MatcherContributor): MatchResult | null {
  const fact = contributor.classify(ctx);
  if (!fact) return null;
  const renderer = defaultRendererRegistry.rendererNameFor(fact.type);
  if (!renderer) return null;
  return {
    type: fact.type,
    specificity: fact.specificity,
    renderer,
    ...(fact.meta ? { meta: fact.meta } : {}),
  };
}

export function extensionMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, extensionContributor);
}

export function directoryMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, directoryContributor);
}

export function parentDirHintMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, parentDirHintContributor);
}

export function smartMdMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, smartMdContributor);
}

export function wikiMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, wikiContributor);
}

const builtinMatchers: AssetMatcher[] = [
  extensionMatcher,
  directoryMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
  wikiMatcher,
];

export function registerBuiltinMatchers(): void {
  for (const matcher of builtinMatchers) {
    registerMatcher(matcher);
  }
}
