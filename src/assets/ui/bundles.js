// Bundles: one card per configured bundle with git status and asset counts, plus the index state.

import { proportionBar } from "./charts.js";
import { api, badge, definitionList, emptyState, fmtNum, fmtPct, html, pageHeader, when } from "./lib.js";

function gitBlock(git) {
  if (!git) return html`<p class="muted">Not a git repository.</p>`;
  const sync =
    git.upstream === null
      ? html`<span class="muted">no upstream</span>`
      : html`<span class="num">${git.ahead} ahead, ${git.behind} behind</span> <span class="muted mono">${git.upstream}</span>`;
  return definitionList([
    [
      "Branch",
      git.branch ? html`<span class="mono">${git.branch}</span>` : html`<span class="muted">detached HEAD</span>`,
    ],
    ["Remote", sync],
    [
      "Uncommitted",
      git.dirtyPaths > 0 ? badge(`${git.dirtyPaths} paths`, "warn") : html`<span class="muted">clean</span>`,
    ],
    [
      "Last commit",
      git.lastCommit
        ? html`${when(git.lastCommit.time)} <span class="mono small">${git.lastCommit.sha.slice(0, 8)}</span><div class="small">${git.lastCommit.subject}</div>`
        : html`<span class="muted">none</span>`,
    ],
  ]);
}

function card(bundle) {
  return html`<article class="card">
    <header class="card-head"><h3>${bundle.name}</h3>${badge(bundle.kind, "info")}${bundle.default ? badge("default", "neutral") : ""}${bundle.writable ? badge("writable", "ok") : badge("read-only", "neutral")}${bundle.exists ? "" : badge("missing", "fail")}</header>
    ${definitionList([
      ["Path", bundle.path ? html`<span class="mono">${bundle.path}</span>` : html`<span class="muted">none</span>`],
      [
        "Source",
        bundle.source?.locator === bundle.path
          ? html`<span class="muted">${bundle.source?.kind ?? "unknown"} path</span>`
          : html`<span class="mono">${bundle.source?.locator ?? ""}</span> <span class="muted">(${bundle.source?.kind ?? "unknown"})</span>`,
      ],
      ["Version", bundle.version],
      ["Assets", html`<span class="num">${fmtNum(bundle.itemCount)}</span>`],
    ])}
    ${proportionBar(bundle.byType ?? {})}
    <h4>Git</h4>${gitBlock(bundle.git)}
  </article>`;
}

const plain = (value) => (typeof value === "string" ? value : JSON.stringify(value));

function indexPanel(index) {
  const semantic = index.semanticSearch;
  return html`<section><h2>Index</h2><div class="card">
    ${definitionList([
      ["Entries", html`<span class="num">${fmtNum(index.entryCount)}</span>`],
      ["Last built", index.lastBuiltAt ? when(index.lastBuiltAt) : html`<span class="muted">never</span>`],
      [
        "Embeddings",
        index.hasEmbeddings
          ? html`<span class="num">${fmtNum(index.embeddingCount)}</span> (${fmtPct(index.embeddingCoverage)} coverage)`
          : html`<span class="muted">none</span>`,
      ],
      [
        "Semantic search",
        semantic ? html`<span class="mono">${semantic.mode}</span> <span class="muted">${semantic.status}</span>` : "",
      ],
      ["Unavailable", index.unavailable ? html`<span class="mono small">${plain(index.unavailable)}</span>` : ""],
      ["Unreadable", index.unreadable ? html`<span class="mono small">${plain(index.unreadable)}</span>` : ""],
    ])}
    ${proportionBar(index.byType ?? {})}
  </div></section>`;
}

export async function render() {
  const data = await api("/api/bundles");
  return html`${pageHeader("Bundles", data.defaultBundle ? html`Default bundle <span class="mono">${data.defaultBundle}</span>${data.defaultWriteTarget ? html`, writes go to <span class="mono">${data.defaultWriteTarget}</span>` : ""}.` : "")}
    <section><h2>Configured bundles</h2>${data.bundles.length === 0 ? emptyState("No bundles are configured.", "Run akm init, or add one with akm bundle add.") : html`<div class="cards">${data.bundles.map(card)}</div>`}</section>
    ${indexPanel(data.index)}`;
}
