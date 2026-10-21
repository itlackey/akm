// akm ui client: hash router and shell. Pages read the local JSON API and return markup
// built with the escaping `html` tag; this file only mounts it.

import { errorState, getMeta, hasUnsaved, html, initToken, loadingState, mount, setUnsaved, showFlash } from "./lib.js";

initToken();

const ROUTES = [
  { name: "overview", label: "Overview", load: () => import("./overview.js"), render: (m, c) => m.render(c) },
  { name: "bundles", label: "Bundles", load: () => import("./bundles.js"), render: (m, c) => m.render(c) },
  { name: "config", label: "Config", load: () => import("./config.js"), render: (m, c) => m.render(c) },
  {
    name: "proposals",
    label: "Proposals",
    load: () => import("./proposals.js"),
    render: (m, c) => (c.param ? m.renderDetail(c) : m.renderList(c)),
  },
  { name: "changes", label: "Changes", load: () => import("./changes.js"), render: (m, c) => m.render(c) },
  { name: "search", label: "Search", load: () => import("./search.js"), render: (m, c) => m.render(c) },
  { name: "asset", label: "Asset", nav: "search", load: () => import("./asset.js"), render: (m, c) => m.render(c) },
  {
    name: "edit",
    label: "Edit Markdown",
    nav: "search",
    load: () => import("./editor.js"),
    render: (m, c) => m.render(c),
  },
  {
    name: "new",
    label: "New knowledge",
    nav: "search",
    load: () => import("./editor.js"),
    render: (m, c) => m.render(c),
  },
];

const main = document.getElementById("app");
let sequence = 0;
let shownHash = location.hash;
let pendingHash = null;
const unsaved = document.getElementById("unsaved");

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/overview";
  const [path, query = ""] = raw.split("?");
  const [name = "overview", ...rest] = path.split("/").filter(Boolean);
  let param = rest.join("/");
  try {
    param = decodeURIComponent(param);
  } catch {
    // Keep the raw segment.
  }
  return { name, param, query: new URLSearchParams(query) };
}

function markNav(active) {
  for (const link of document.querySelectorAll("nav a[data-route]")) {
    if (link.dataset.route === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function route() {
  if (hasUnsaved()) {
    // Keep the editor's address and ask inline; "Discard changes" repeats the navigation.
    pendingHash = location.hash;
    if (location.hash !== shownHash) history.replaceState(null, "", location.pathname + location.search + shownHash);
    mount(
      unsaved,
      html`<p>You have unsaved changes.</p><p class="btn-row"><button type="button" class="btn-danger" data-act="discard">Discard changes</button><button type="button" class="btn-secondary" data-act="keep">Keep editing</button></p>`,
    );
    unsaved.hidden = false;
    unsaved.querySelector("[data-act=keep]")?.focus();
    return;
  }
  unsaved.hidden = true;
  shownHash = location.hash;
  const mine = ++sequence;
  const { name, param, query } = parseHash();
  const entry = ROUTES.find((r) => r.name === name);
  markNav(entry ? (entry.nav ?? entry.name) : "");
  document.title = `${entry ? entry.label : "Not found"} - akm ui`;
  main.setAttribute("aria-busy", "true");
  mount(main, loadingState());
  const ctx = { query, param, after: [] };
  try {
    if (!entry) {
      mount(
        main,
        html`<div class="state state-empty"><p class="state-title">No such page</p><p>Try the <a href="#/overview">overview</a>.</p></div>`,
      );
    } else {
      const page = await entry.load();
      const markup = await entry.render(page, ctx);
      if (mine !== sequence) return;
      mount(main, markup);
      for (const fn of ctx.after) fn(main);
      showFlash(main);
      window.scrollTo(0, 0);
    }
  } catch (error) {
    if (mine === sequence) mount(main, errorState(error));
  } finally {
    if (mine === sequence) main.removeAttribute("aria-busy");
  }
}

async function showMeta() {
  const target = document.getElementById("nav-meta");
  try {
    const meta = await getMeta();
    mount(
      target,
      html`<span class="mono">akm ${meta.version}</span><span class="muted small">${meta.readOnly ? "read-only" : ""} ${meta.runtime}</span>`,
    );
  } catch {
    mount(target, html``);
  }
}

window.addEventListener("hashchange", route);
unsaved.addEventListener("click", (event) => {
  const act = event.target.closest("button")?.dataset.act;
  if (!act) return;
  unsaved.hidden = true;
  if (act !== "discard") return;
  setUnsaved(false);
  const target = pendingHash;
  pendingHash = null;
  // A same-hash target (Refresh view) fires no hashchange, so route directly.
  if (target === null || target === location.hash) route();
  else location.hash = target;
});
window.addEventListener("beforeunload", (event) => {
  if (!hasUnsaved()) return;
  event.preventDefault();
  event.returnValue = true; // Older browsers ask only when this is set.
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (location.hash.startsWith("#/search")) document.querySelector('input[name="q"]')?.focus();
    else location.hash = "#/search";
  }
});
document.querySelector("[data-refresh]")?.addEventListener("click", route);
showMeta();
route();
