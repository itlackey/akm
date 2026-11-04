// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @ts-nocheck -- presentation code copied from AKM: DOM string building, not type-checked here.
// Presentation helpers owned by Desktop, copied from AKM's design system (src/assets/ui, MPL-2.0).
//
// Every string that reaches the DOM goes through `html` (a tagged template that escapes each interpolated value) and
// `mount` (the only place that writes markup into the page), so reading this file is enough to audit how page content
// is escaped.

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for use in element content or a quoted attribute value. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Markup that is already safe: only `html` creates one. */
class SafeHtml {
  constructor(text) {
    this.text = text;
  }
}

function part(value) {
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(part).join("");
  if (value === null || value === undefined || value === false) return "";
  return esc(value);
}

/** Tagged template: literal parts are trusted markup, every interpolated value is escaped unless it is itself `html`. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Replace the contents of `element` with `safe`. The one markup write in the client. */
export function mount(element, safe) {
  if (!(safe instanceof SafeHtml)) throw new TypeError("mount() takes the result of html``");
  element.innerHTML = safe.text;
}

/** The Monday (00:00 UTC) of the week holding `iso`, as YYYY-MM-DD. */
export function weekStart(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function assetHref(ref, returnTo = "") {
  return `/library/asset?ref=${encodeURIComponent(ref)}${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`;
}

const round = (n) => Math.round(n * 10) / 10;

/** A tiny line of `values` (nulls are gaps) with no axes: shape only, the number beside it is the fact. */
export function sparkline(values, label = "Weekly trend") {
  const known = values.filter((v) => typeof v === "number");
  if (known.length < 3) return "";
  const W = 120;
  const H = 28;
  const max = Math.max(...known, 0.0001);
  const min = Math.min(...known);
  const span = max - min || 1;
  const step = W / Math.max(values.length - 1, 1);
  const segments = [];
  let current = [];
  values.forEach((v, i) => {
    if (typeof v !== "number") {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push(`${round(i * step)},${round(H - 2 - ((v - min) / span) * (H - 4))}`);
  });
  if (current.length) segments.push(current);
  return html`<svg class="tile-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}">${segments.map((points) => html`<polyline points="${points.join(" ")}"/>`)}</svg>`;
}
