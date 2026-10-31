// Compact bundle distribution visuals use CSS colours that follow the light/dark theme.

import { html } from "./lib.js";

const round = (n) => Math.round(n * 10) / 10;

/** A small horizontal bar for a table cell: `value` of `max`, with the `failed` part in the failure colour. */
export function miniBar(value, max, failed = 0, label = "") {
  const W = 96;
  const w = max > 0 ? round((value / max) * W) : 0;
  const fw = max > 0 ? round((failed / max) * W) : 0;
  return html`<svg class="minibar" viewBox="0 0 ${W} 10" width="${W}" height="10" role="img" aria-label="${label}"><rect class="track" width="${W}" height="10" rx="2"/><rect class="fill" width="${w}" height="10" rx="2"/>${fw > 0 ? html`<rect class="fail" x="${round(w - fw)}" width="${fw}" height="10" rx="2"/>` : ""}</svg>`;
}

const PALETTE = ["s1", "s2", "s3", "s4", "s5", "s6"];

/** A stacked proportion bar (HTML, not SVG) with a legend listing each part's count. `counts` is { name: n }. */
export function proportionBar(counts) {
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return html`<p class="muted">No assets.</p>`;
  return html`<div class="propbar" role="img" aria-label="${entries.map(([k, n]) => `${k} ${n}`).join(", ")}">${entries.map(
    ([k, n], i) =>
      html`<span class="${PALETTE[i % PALETTE.length]}" style="width:${round((n / total) * 100)}%" title="${k}: ${n}"></span>`,
  )}</div>
  <ul class="legend">${entries.map(([k, n], i) => html`<li><span class="swatch ${PALETTE[i % PALETTE.length]}"></span>${k} <span class="num">${n}</span></li>`)}</ul>`;
}
