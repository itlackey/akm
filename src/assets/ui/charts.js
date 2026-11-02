// Compact bundle distribution visuals use CSS colours that follow the light/dark theme.

import { html, stackedBar } from "./lib.js";

const round = (n) => Math.round(n * 10) / 10;

const PALETTE = ["series-1", "series-2", "series-3", "series-4", "series-5", "series-6"];

/** A stacked proportion bar with a legend listing each part's count. `counts` is { name: n }. */
export function proportionBar(counts) {
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return html`<p class="muted">No assets.</p>`;
  const parts = entries.map(([k, n], i) => ({ n, cls: PALETTE[i % PALETTE.length], title: `${k}: ${n}` }));
  return html`${stackedBar(parts, { label: entries.map(([k, n]) => `${k} ${n}`).join(", ") })}
  <ul class="legend">${entries.map(([k, n], i) => html`<li><span class="series-key ${PALETTE[i % PALETTE.length]}"></span>${k} <span class="num">${n}</span></li>`)}</ul>`;
}

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
