// akm ui client: hash router and shell. Pages read the local JSON API and return markup
// built with the escaping `html` tag; this file only mounts it.

import { errorState, getMeta, html, initToken, loadingState, mount } from "./lib.js";

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
    name: "new",
    label: "New knowledge",
    nav: "search",
    load: () => import("./editor.js"),
    render: (m, c) => m.render(c),
  },
];

const main = document.getElementById("app");
let sequence = 0;

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
