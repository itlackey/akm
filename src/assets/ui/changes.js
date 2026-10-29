// Changes: recent commits of the write-target stash as a timeline grouped by day.

import { api, badge, emptyState, html, pageHeader } from "./lib.js";

const ORIGIN_KIND = { "improve-sync": "info", accept: "ok", remember: "accent", sync: "neutral", other: "warn" };

function commit(c) {
  const more = c.pathCount > c.paths.length;
  return html`<li class="commit">
    <div class="commit-head"><span class="mono small time">${c.time.slice(11, 16)}</span>${badge(c.origin, ORIGIN_KIND[c.origin] ?? "neutral")}<span class="commit-subject">${c.subject}</span></div>
    <div class="muted small"><span class="mono">${c.shortSha}</span> by ${c.author}</div>
    ${c.pathCount > 0 ? html`<details><summary>${c.pathCount} changed ${c.pathCount === 1 ? "path" : "paths"}</summary><ul class="plain mono small">${c.paths.map((p) => html`<li class="wrap">${p}</li>`)}${more ? html`<li class="muted">and ${c.pathCount - c.paths.length} more</li>` : ""}</ul></details>` : ""}
  </li>`;
}

export async function render() {
  const data = await api("/api/changes", { limit: 100 });
  const head = pageHeader(
    "Changes",
    html`Recent commits to <span class="mono">${data.bundle ?? "the stash"}</span>${data.path ? html` (<span class="mono wrap">${data.path}</span>)` : ""}.`,
  );
  if (!data.git) {
    return html`${head}${emptyState("This stash is not a git repository.", "Changes are read from its git log, so there is no history to show.")}`;
  }
  if (data.commits.length === 0) return html`${head}${emptyState("No commits yet.")}`;
  const days = new Map();
  for (const c of data.commits) {
    const day = c.time.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), c]);
  }
  return html`${head}<div class="timeline">${[...days].map(([day, items]) => html`<section><h2 class="day">${day} <span class="muted num">${items.length}</span></h2><ol class="commits">${items.map(commit)}</ol></section>`)}</div>`;
}
