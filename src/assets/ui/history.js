// History: recent commits of the write-target stash as a timeline grouped by day.

import { api, badge, emptyState, html, pageHeader, wireFilterForm } from "./lib.js";

const ORIGIN_KIND = { "improve-sync": "info", accept: "ok", remember: "accent", sync: "neutral", other: "warn" };

const pad = (n) => String(n).padStart(2, "0");

/** A commit's day and time in the reader's time zone, from one Date so a day heading always agrees with the times under it. */
function localDayTime(iso) {
  const d = new Date(iso);
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function commit(c) {
  const more = c.pathCount > c.paths.length;
  return html`<li class="commit">
    <div class="commit-head"><span class="mono small time">${localDayTime(c.time).time}</span>${badge(c.origin, ORIGIN_KIND[c.origin] ?? "neutral")}<span class="commit-subject">${c.subject}</span></div>
    <div class="muted small"><span class="mono">${c.shortSha}</span> by ${c.author}</div>
    ${c.pathCount > 0 ? html`<details class="toggle"><summary>${c.pathCount} changed ${c.pathCount === 1 ? "path" : "paths"}</summary><ul class="plain mono small">${c.paths.map((p) => html`<li class="wrap">${p}</li>`)}${more ? html`<li class="muted">and ${c.pathCount - c.paths.length} more</li>` : ""}</ul></details>` : ""}
  </li>`;
}

export async function render(ctx) {
  const data = await api("/api/changes", { limit: 100 });
  const head = pageHeader(
    "History",
    html`Recent commits to <span class="mono">${data.bundle ?? "the stash"}</span>${data.path ? html` (<span class="mono wrap">${data.path}</span>)` : ""}. Times are in your time zone.`,
  );
  if (!data.git) {
    return html`${head}${emptyState("This stash is not a git repository.", "Changes are read from its git log, so there is no history to show.")}`;
  }
  if (data.commits.length === 0) return html`${head}${emptyState("No commits yet.")}`;
  const days = new Map();
  for (const c of data.commits) {
    const { day } = localDayTime(c.time);
    days.set(day, [...(days.get(day) ?? []), c]);
  }
  const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
  const match = (c) =>
    !q ||
    [c.subject, c.author, c.shortSha, c.origin, ...c.paths].some((text) => String(text).toLowerCase().includes(q));
  const origin = ctx.query.get("origin") ?? "";
  ctx.after.push((root) => wireFilterForm(root.querySelector("form.history-filter"), "history"));
  const shown = new Map();
  for (const [day, items] of days) {
    const kept = items.filter((c) => match(c) && (!origin || c.origin === origin));
    if (kept.length) shown.set(day, kept);
  }
  const origins = [...new Set(data.commits.map((c) => c.origin))].sort();
  const filter = html`<form class="history-filter" role="search" aria-label="Filter commits"><div class="field"><label class="field-label" for="h-q">Filter</label><input id="h-q" type="search" name="q" value="${q}" placeholder="Subject, author, path"></div><div class="field search-filter"><label class="field-label" for="h-origin">Made by</label><select id="h-origin" name="origin"><option value="">Anything</option>${origins.map((o) => html`<option value="${o}" ${o === origin ? html`selected` : ""}>${o}</option>`)}</select></div><button type="submit">Filter</button></form>`;
  if (shown.size === 0)
    return html`${head}${filter}${emptyState("No commit matches.", html`<a href="#/history">Clear the filter</a>`)}`;
  return html`${head}${filter}<div class="timeline">${[...shown].map(([day, items]) => html`<section><h2 class="day">${day} <span class="muted num">${items.length}</span></h2><ol class="commits">${items.map(commit)}</ol></section>`)}</div>`;
}
