// The gallery: every shared builder of /lib.js and every control the client styles, on one page (plan 8.7).
// Served by the visual specs on the UI origin with the product's own Content-Security-Policy header (visitGallery checks it).

import {
  badge,
  definitionList,
  emptyState,
  errorState,
  html,
  loadingState,
  mount,
  pageHeader,
  statusKind,
  tableWrap,
} from "/lib.js";

const KINDS = ["ok", "warn", "fail", "info", "accent", "neutral"];

const section = (title, body) => html`<section data-gallery="${title}"><h2>${title}</h2>${body}</section>`;

const page = html`${pageHeader("Gallery", "Shared builders and controls, as the client draws them today.")}
  ${section("Badges", html`<p class="badges">${KINDS.map((kind) => badge(kind, kind))}${["pass", "warn", "fail", "unknown"].map((status) => badge(status, statusKind(status)))}</p>`)}
  ${section("Buttons", html`<p class="btn-row"><button type="button">Primary</button><button type="button" class="btn-secondary">Secondary</button><button type="button" class="btn-danger">Danger</button><button type="button" disabled>Disabled</button></p>`)}
  ${section("Chips and tags", html`<div class="chips"><a class="chip active" href="#/gallery" aria-current="true">All <span class="num">12</span></a><a class="chip" href="#/gallery">reflect <span class="num">5</span></a><a class="chip" href="#/gallery">distill <span class="num">3</span></a></div><div class="tags"><span class="tag">deploy</span><span class="tag">runbook</span></div>`)}
  ${section("Form controls", html`<form class="form-grid"><label>Query<input type="search" name="q" value="deploy script"></label><label>Type<select name="type"><option>All types</option><option>knowledge</option></select></label><label>Notes<textarea name="notes" rows="3">A short note.</textarea></label><label class="check"><input type="checkbox" checked> Selected</label></form>`)}
  ${section("Notices", html`<div class="notice">A neutral notice.</div><div class="notice notice-warn">A warning notice.</div>`)}
  ${section("States", html`${emptyState("Nothing here yet.", "Detail that says what to do next.")}${loadingState()}${errorState(new Error("The index could not be read."))}`)}
  ${section("Table", tableWrap(html`<table><thead><tr><th>Asset</th><th class="r">Count</th></tr></thead><tbody><tr><td class="mono">stash//knowledge/deploy-guide</td><td class="r num">1,204</td></tr><tr><td class="mono">stash//lessons/rg</td><td class="r num">87</td></tr></tbody></table>`))}
  ${section(
    "Definition list",
    definitionList([
      ["Ref", html`<span class="mono">stash//knowledge/deploy-guide</span>`],
      ["Type", "knowledge"],
      ["Updated", "2 days ago"],
    ]),
  )}
  ${section("Type", html`<p class="muted">Muted text.</p><p class="small">Small text.</p><p><code>inline code</code> and <span class="mono">mono text</span></p><pre class="code">const code = "block";</pre>`)}`;

mount(document.getElementById("app"), page);
