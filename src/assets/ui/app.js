// akm ui client: hash router and shell. Pages read the local JSON API and return markup
// built with the escaping `html` tag; this file only mounts it.

import {
  announce,
  api,
  errorState,
  getMeta,
  hasUnsaved,
  html,
  initToken,
  loadingState,
  mount,
  setRouteSignal,
  setUnsaved,
  showFlash,
} from "./lib.js";

initToken();

// ---- theme: System follows the device; Light and Dark force a scheme. The choice is kept in this browser. ----
const THEME_KEY = "akm-ui-theme";
function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}
function applyTheme(value) {
  if (value === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  window.dispatchEvent(new Event("akm-theme"));
}
applyTheme(storedTheme());
document.querySelector("[data-theme-control]")?.addEventListener("change", (event) => {
  const value = event.target.value;
  try {
    if (value === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
  } catch {
    // The choice then lasts for this visit only.
  }
  applyTheme(value);
});
{
  const chosen = document.querySelector(`[data-theme-control] input[value="${storedTheme()}"]`);
  if (chosen) chosen.checked = true;
}

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
  { name: "improve", label: "Improve impact", load: () => import("./improve.js"), render: (m, c) => m.render(c) },
  { name: "history", label: "History", load: () => import("./history.js"), render: (m, c) => m.render(c) },
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
    load: () => import("./editor.js"),
    render: (m, c) => m.render(c),
  },
];

const main = document.getElementById("app");
let sequence = 0;
let shownHash = location.hash;
let pendingHash = null;
let cleanup = [];
let pageRequests = null;
const positions = new Map();
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

/** The route name of a hash such as `#/search?q=x`. */
function routeName(hash) {
  return hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "overview";
}

/** True when `a` and `b` are the same route and parameter, so only the query changed. */
function sameShownPage(a, b) {
  const path = (hash) => hash.replace(/^#\/?/, "").split("?")[0];
  return path(a) === path(b);
}

function markNav(active) {
  for (const link of document.querySelectorAll("nav a[data-route]")) {
    if (link.dataset.route === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

/** The current form of an address that an earlier release used; `null` when the address is current. */
function currentAddress({ name, param, query }) {
  const rest = (params) => (params.size > 0 ? `?${params}` : "");
  if (name === "changes") return `/history${rest(query)}`;
  if ((name === "asset" || name === "edit") && !param && query.get("ref")) {
    const params = new URLSearchParams(query);
    const ref = params.get("ref");
    params.delete("ref");
    return `/${name}/${encodeURIComponent(ref)}${rest(params)}`;
  }
  if (name === "overview" && ["24h", "7d"].includes(query.get("window") ?? "")) {
    const params = new URLSearchParams(query);
    params.set("window", "30d");
    return `/overview?${params}`;
  }
  return null;
}

async function route() {
  const legacy = currentAddress(parseHash());
  // Replace, not push: the old address should not stay in the history.
  if (legacy) history.replaceState(null, "", `${location.pathname}${location.search}#${legacy}`);
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
  const oldHash = shownHash;
  const active = document.activeElement;
  const focus = main.contains(active) ? { name: active.name, href: active.getAttribute("href") } : null;
  positions.set(oldHash, { scroll: window.scrollY, focus });
  for (const dispose of cleanup) dispose();
  cleanup = [];
  shownHash = location.hash;
  const mine = ++sequence;
  // Leaving a page abandons its requests: a slow answer for a page the reader has left is never drawn.
  pageRequests?.abort();
  pageRequests = new AbortController();
  setRouteSignal(pageRequests.signal);
  const { name, param, query } = parseHash();
  const entry = ROUTES.find((r) => r.name === name);
  markNav(entry ? (entry.nav ?? entry.name) : "");
  document.title = `${entry ? entry.label : "Not found"} · akm ui`;
  main.setAttribute("aria-busy", "true");
  mount(main, loadingState());
  const ctx = { query, param, after: [], announcement: null, signal: pageRequests.signal };
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
      for (const fn of ctx.after) {
        const dispose = fn(main);
        if (typeof dispose === "function") cleanup.push(dispose);
      }
      showFlash(main);
      const restored = positions.get(shownHash);
      // A change inside one page (a filter, the window) keeps focus on the control that caused it.
      const wanted = restored?.focus ?? (routeName(oldHash) === name ? focus : null);
      if (wanted) {
        [...main.querySelectorAll("[name], a[href]")]
          .find((node) => (wanted.name ? node.name === wanted.name : node.getAttribute("href") === wanted.href))
          ?.focus({ preventScroll: true });
      }
      // `autofocus` only applies on a document's first load, so honour it for content mounted later.
      if (document.activeElement === document.body) main.querySelector("[autofocus]")?.focus({ preventScroll: true });
      // A new page takes focus at its heading, so a keyboard user starts at the top and a screen reader names the page.
      const heading = main.querySelector("h1");
      if (heading && !main.contains(document.activeElement)) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      window.scrollTo(0, restored?.scroll ?? 0);
      const specific = heading?.textContent?.trim();
      document.title = `${specific && specific !== entry.label ? `${specific} · ` : ""}${entry.label} · akm ui`;
      // A page may supply its own message (Search says how many results); otherwise name the page when it changes.
      if (ctx.announcement) announce(ctx.announcement);
      else if (!sameShownPage(oldHash, shownHash))
        announce(specific ? `${specific}. ${entry.label} page loaded.` : `${entry.label} page loaded.`);
    }
  } catch (error) {
    if (mine === sequence) mount(main, errorState(error));
  } finally {
    if (mine === sequence) main.removeAttribute("aria-busy");
  }
}

async function showPendingCount() {
  const target = document.querySelector("[data-pending-count]");
  if (!target) return;
  try {
    const { fullCount } = await api("/api/proposals", { status: "pending", limit: 1 }, { signal: null });
    target.textContent = String(fullCount);
    target.hidden = !fullCount;
  } catch {
    target.hidden = true;
  }
}

async function showMeta() {
  const target = document.getElementById("nav-meta");
  try {
    const meta = await getMeta();
    mount(
      target,
      html`<span class="mono" data-volatile>akm ${meta.version} · ${meta.hostname}</span><span class="muted small">${meta.runtime}</span>`,
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
  if (act !== "discard") {
    if (main.querySelector("[data-source-panel]")?.hidden) main.querySelector("[data-preview-toggle]")?.click();
    main.querySelector('[name="content"]')?.focus({ preventScroll: true });
    return;
  }
  setUnsaved(false);
  const target = pendingHash;
  pendingHash = null;
  // A same-hash target fires no hashchange, so route directly.
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
// The skip link must not change the hash: that would route to a page called "app".
document.querySelector(".skip-link")?.addEventListener("click", (event) => {
  event.preventDefault();
  main.focus();
});
// Esc on the unsaved-changes notice means "Keep editing".
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || unsaved.hidden) return;
  unsaved.querySelector("[data-act=keep]")?.click();
});
const menu = document.querySelector("[data-menu]");
const topbar = document.querySelector(".topbar");
function setMenu(open) {
  menu?.setAttribute("aria-expanded", String(open));
  topbar?.classList.toggle("nav-open", open);
}
menu?.addEventListener("click", () => setMenu(menu.getAttribute("aria-expanded") !== "true"));
document.querySelector(".nav-links")?.addEventListener("click", (event) => {
  if (event.target.closest("a")) setMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || menu?.getAttribute("aria-expanded") !== "true") return;
  setMenu(false);
  menu.focus();
});
document.addEventListener("click", (event) => {
  if (menu?.getAttribute("aria-expanded") === "true" && !event.target.closest(".topbar")) setMenu(false);
});
document.querySelector("[data-topbar-search]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.q;
  const q = input.value.trim();
  location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : "#/search";
  input.value = "";
  setMenu(false);
});
showMeta();
showPendingCount();
window.addEventListener("hashchange", showPendingCount);
route();
