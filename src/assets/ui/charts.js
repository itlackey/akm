// Inline SVG charts. Colours come from CSS classes (see styles.css) so they follow the light/dark theme.

import { html } from "./lib.js";

const round = (n) => Math.round(n * 10) / 10;

/** A "nice" axis top and tick list for counts: steps of 1, 2 or 5 times a power of ten, at most 5 intervals. */
export function niceScale(max) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  let step = 1;
  while (max / step > 5) step *= max / step > 25 ? 10 : max / step > 10 ? 5 : 2;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

export const USAGE_SERIES = [
  { key: "search", label: "Search", cls: "s1" },
  { key: "curate", label: "Curate", cls: "s2" },
  { key: "show", label: "Show", cls: "s3" },
  { key: "feedback", label: "Feedback", cls: "s4" },
];

/** Stacked daily bars on one scale. `days` is `usageByDay` from /api/overview. */
export function usageChart(days) {
  const rows = days.map((d) => ({
    date: d.date,
    search: d.search ?? 0,
    curate: d.curate ?? 0,
    show: d.show ?? 0,
    feedback: (d.feedbackPositive ?? 0) + (d.feedbackNegative ?? 0),
  }));
  const total = (r) => USAGE_SERIES.reduce((sum, s) => sum + r[s.key], 0);
  const scale = niceScale(Math.max(0, ...rows.map(total)));
  const W = 640;
  const H = 260;
  const left = 44;
  const right = 8;
  const top = 18;
  const bottom = 34;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const slot = plotW / rows.length;
  const barW = slot * 0.62;
  const y = (v) => round(top + plotH - (v / scale.top) * plotH);

  const grid = scale.ticks.map(
    (v) =>
      html`<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`,
  );
  const bars = rows.map((r, i) => {
    const x = round(left + i * slot + (slot - barW) / 2);
    let acc = 0;
    const segments = USAGE_SERIES.map((s) => {
      const v = r[s.key];
      if (v === 0) return "";
      const rect = html`<rect class="${s.cls}" x="${x}" y="${y(acc + v)}" width="${round(barW)}" height="${round(y(acc) - y(acc + v))}"/>`;
      acc += v;
      return rect;
    });
    const sum = total(r);
    const tip = `${r.date}: ${USAGE_SERIES.map((s) => `${s.label.toLowerCase()} ${r[s.key]}`).join(", ")} (total ${sum})`;
    return html`<g><title>${tip}</title>${segments}${sum > 0 ? html`<text class="axis total" x="${round(x + barW / 2)}" y="${y(sum) - 4}" text-anchor="middle">${sum}</text>` : ""}<text class="axis" x="${round(x + barW / 2)}" y="${H - bottom + 16}" text-anchor="middle">${r.date.slice(5)}</text></g>`;
  });
  const label = `Daily usage events for the last ${rows.length} days, stacked by search, curate, show and feedback`;
  return html`<div class="chart-scroll"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${grid}${bars}<text class="axis" x="${left}" y="10">events per day (UTC)</text></svg></div>
    <ul class="legend">${USAGE_SERIES.map((s) => html`<li><span class="swatch ${s.cls}"></span>${s.label}</li>`)}</ul>`;
}

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
