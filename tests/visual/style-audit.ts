// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The computed-style audit: walks the DOM and reports every font-size, weight, line-height,
 * colour, border colour, radius, padding, margin, gap and shadow value that no `:root` token produces. A token's value
 * is resolved through a probe element, so `--space-2: 0.5rem` allows `8px`. New pages must report none; old pages
 * may not report more than the ratchet file records.
 */

import type { Page } from "@playwright/test";

/** group -> the distinct off-token values found, sorted. */
export type Audit = Record<string, string[]>;
/** route -> its audit, as stored in `style-audit.ratchet.json`. */
export type Ratchet = Record<string, Audit>;

/** Runs in the page. Written as one function because Playwright serialises it. */
function collectOffToken(): Audit {
  // group -> [the properties read from each element, the one property used to resolve a token]
  const GROUPS: Record<string, [string[], string]> = {
    "font-size": [["font-size"], "font-size"],
    "font-weight": [["font-weight"], "font-weight"],
    "line-height": [["line-height"], "line-height"],
    color: [["color"], "color"],
    "background-color": [["background-color"], "background-color"],
    "border-color": [
      ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"],
      "border-top-color",
    ],
    "border-radius": [
      ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"],
      "border-top-left-radius",
    ],
    padding: [["padding-top", "padding-right", "padding-bottom", "padding-left"], "padding-left"],
    margin: [["margin-top", "margin-right", "margin-bottom", "margin-left"], "margin-left"],
    gap: [["row-gap", "column-gap"], "column-gap"],
    "box-shadow": [["box-shadow"], "box-shadow"],
  };
  const NOT_A_VALUE = new Set(["0px", "normal", "none", "auto", "rgba(0, 0, 0, 0)"]);

  const root = document.documentElement;
  // A unitless line-height computes to px; compare it as a ratio of its own font-size, for tokens and elements alike.
  const normalise = (group: string, value: string, fontSize: string): string =>
    group === "line-height" && value.endsWith("px")
      ? String(Math.round((Number.parseFloat(value) / Number.parseFloat(fontSize)) * 1000) / 1000)
      : value;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  document.body.append(probe);

  const rootStyle = getComputedStyle(root);
  const tokens = [...rootStyle].filter((name) => name.startsWith("--"));
  const allowed = new Map<string, Set<string>>(Object.keys(GROUPS).map((group) => [group, new Set()]));
  for (const [group, [, property]] of Object.entries(GROUPS)) {
    for (const token of tokens) {
      const raw = rootStyle.getPropertyValue(token).trim();
      if (!raw || !CSS.supports(property, raw)) continue;
      probe.style.setProperty(property, `var(${token})`);
      const probed = getComputedStyle(probe);
      allowed.get(group)?.add(normalise(group, probed.getPropertyValue(property), probed.fontSize));
      probe.style.removeProperty(property);
    }
  }
  probe.remove();

  // An `auto` margin computes to whatever space is left, so it is layout, not a value to audit. It is read from the
  // declared text, because a logical or var()-bearing shorthand leaves the physical longhands empty.
  const autoMargins: Array<[string, string]> = [];
  // Longhands (physical and logical) -> the physical side, for horizontal-tb ltr.
  const LONGHANDS: Record<string, string> = {
    "margin-top": "margin-top",
    "margin-right": "margin-right",
    "margin-bottom": "margin-bottom",
    "margin-left": "margin-left",
    "margin-block-start": "margin-top",
    "margin-block-end": "margin-bottom",
    "margin-inline-start": "margin-left",
    "margin-inline-end": "margin-right",
  };
  const words = (text: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let word = "";
    for (const char of text.trim()) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (/\s/.test(char) && depth === 0) {
        if (word) out.push(word);
        word = "";
      } else word += char;
    }
    if (word) out.push(word);
    return out;
  };
  const autoSides = (style: CSSStyleDeclaration): string[] => {
    const sides: string[] = [];
    for (const [property, side] of Object.entries(LONGHANDS)) {
      if (style.getPropertyValue(property) === "auto") sides.push(side);
    }
    // 1 value: all; 2: block inline; 3: top inline bottom; 4: top right bottom left.
    const [a = "", b = a, c = a, d = b] = words(style.getPropertyValue("margin"));
    for (const [side, value] of [
      ["margin-top", a],
      ["margin-right", b],
      ["margin-bottom", c],
      ["margin-left", d],
    ]) {
      if (value === "auto") sides.push(side as string);
    }
    const [inStart = "", inEnd = inStart] = words(style.getPropertyValue("margin-inline"));
    if (inStart === "auto") sides.push("margin-left");
    if (inEnd === "auto") sides.push("margin-right");
    const [blStart = "", blEnd = blStart] = words(style.getPropertyValue("margin-block"));
    if (blStart === "auto") sides.push("margin-top");
    if (blEnd === "auto") sides.push("margin-bottom");
    return sides;
  };
  const collectAuto = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        for (const side of autoSides(rule.style)) autoMargins.push([rule.selectorText, side]);
      }
      if ("cssRules" in rule) collectAuto(rule.cssRules as CSSRuleList);
    }
  };
  for (const sheet of document.styleSheets) collectAuto(sheet.cssRules);
  const isAuto = (element: Element, property: string): boolean =>
    autoMargins.some(([selector, side]) => side === property && element.matches(selector));

  const found = new Map<string, Set<string>>(Object.keys(GROUPS).map((group) => [group, new Set()]));
  for (const element of document.body.querySelectorAll("*")) {
    // A chart's inner shapes are drawn from data and attributes, not from the stylesheet.
    if (element.closest("svg") && element.tagName.toLowerCase() !== "svg") continue;
    const style = getComputedStyle(element);
    if (style.display === "none") continue;
    for (const [group, [properties]] of Object.entries(GROUPS)) {
      for (const property of properties) {
        if (group === "border-color" && style.getPropertyValue(property.replace("color", "style")) === "none") continue;
        if (group === "margin" && isAuto(element, property)) continue;
        const value = normalise(group, style.getPropertyValue(property), style.fontSize);
        if (NOT_A_VALUE.has(value) || allowed.get(group)?.has(value)) continue;
        found.get(group)?.add(value);
      }
    }
  }
  return Object.fromEntries(
    [...found].filter(([, values]) => values.size > 0).map(([group, values]) => [group, [...values].sort()]),
  );
}

export function auditStyles(page: Page): Promise<Audit> {
  return page.evaluate(collectOffToken);
}

const flatten = (audit: Audit): Set<string> =>
  new Set(Object.entries(audit).flatMap(([group, values]) => values.map((value) => `${group}: ${value}`)));

/** The off-token values of a page that the ratchet does not allow for it (all of them, when the route is not recorded). */
export function newOffToken(found: Audit, allowed: Audit = {}): string[] {
  const before = flatten(allowed);
  return [...flatten(found)].filter((entry) => !before.has(entry));
}
