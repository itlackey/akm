<script lang="ts">
  import { onMount, tick } from "svelte";
  import { beforeNavigate, afterNavigate } from "$app/navigation";
  import { navigating } from "$app/state";
  import Library from "../lib/Library.svelte";
  import Home from "../lib/Home.svelte";
  import Review from "../lib/Review.svelte";
  import Activity from "../lib/Activity.svelte";
  import Settings from "../lib/Settings.svelte";
  import { api } from "../lib/client";
  import { hasUnsaved } from "../lib/ui/lib.js";
  import { navigate } from "../lib/navigation";
  import type { Bundle } from "../lib/types";
  import "../lib/ui/tokens.css";
  import "../lib/ui/base.css";
  import "../lib/ui/layout.css";
  import "../lib/ui/components.css";
  import "../lib/ui/pages.css";
  import "../lib/ui/utilities.css";
  import "../lib/desktop.css";

  const sections = ["Home", "Library", "Review", "Activity", "Settings"] as const;
  type Section = (typeof sections)[number];
  type Page = { route: string; query: URLSearchParams };
  let section: Section = "Home",
    ready = false,
    error = "";
  let metadata: { hostname: string; akmVersion: string; version: string; commit?: string } | null = null;
  let bundles: Bundle[] = [],
    defaultWriteTarget = "",
    bundlesReady = false;
  let pendingCount: number | null = null;
  let theme = "system",
    themeError = "",
    shownHash = "#/home",
    bundleRevision = 0;
  let main: HTMLElement;
  let library: { openSearch: () => Promise<void> } | undefined;
  let leaveDialog: HTMLDialogElement;
  let pendingNavigation: { href: string; delta?: number } | null = null;
  let approvedDestination = "";
  let editorFocus: HTMLElement | null = null;
  let visited = new Set<Section>();
  let pages: Record<Section, Page> = {
    Home: { route: "home", query: new URLSearchParams() },
    Library: { route: "search", query: new URLSearchParams() },
    Review: { route: "proposals", query: new URLSearchParams() },
    Activity: { route: "overview", query: new URLSearchParams() },
    Settings: { route: "bundles", query: new URLSearchParams() },
  };
  const positions = new Map<string, number>();
  beforeNavigate((navigation) => {
    if (approvedDestination && navigation.to?.url.href === approvedDestination) {
      approvedDestination = "";
      return;
    }
    if (section !== "Library" || !["edit", "new"].includes(pages.Library.route) || !hasUnsaved()) return;
    if (navigation.to?.url.hash === shownHash && !navigation.willUnload) return;
    navigation.cancel();
    if (navigation.willUnload || pendingNavigation || !navigation.to) return;
    pendingNavigation = {
      href: navigation.to.url.href,
      ...(navigation.type === "popstate" ? { delta: navigation.delta } : {}),
    };
    editorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => leaveDialog?.showModal());
  });
  afterNavigate(() => {
    // A completed save may open its reader while a leave prompt is pending.
    // Once there is no unsaved work, that prompt no longer describes reality.
    if (pendingNavigation && !hasUnsaved()) {
      pendingNavigation = null;
      approvedDestination = "";
      leaveDialog?.close();
    }
    void readRoute();
  });
  function stayInEditor() {
    pendingNavigation = null;
    leaveDialog.close();
    editorFocus?.focus({ preventScroll: true });
  }
  async function leaveAndKeep() {
    const destination = pendingNavigation;
    if (!destination) return;
    pendingNavigation = null;
    leaveDialog.close();
    approvedDestination = destination.href;
    // Kit has already cancelled/restored the original traversal. Retry the same
    // user-requested history delta, letting Kit own the history bookkeeping.
    if (destination.delta) history.go(destination.delta);
    else
      try {
        await navigate(destination.href);
      } catch (cause) {
        approvedDestination = "";
        error = (cause as Error).message;
      }
  }
  function sectionFor(route: string): Section {
    const base = route.split("/")[0];
    if (base === "home") return "Home";
    if (base === "proposals") return "Review";
    if (["overview", "improve", "history"].includes(base)) return "Activity";
    if (["bundles", "config", "software"].includes(base)) return "Settings";
    return "Library";
  }
  function href(name: Section) {
    const page = pages[name],
      query = page.query.toString();
    return "#/" + page.route + (query ? "?" + query : "");
  }
  async function refreshPending() {
    try {
      const data = await api<{ fullCount: number }>("/proposals", { status: "pending", limit: "1" });
      pendingCount = data.fullCount;
    } catch {
      pendingCount = null; /* An unreadable queue is not a zero count. */
    }
  }
  async function refreshBundles(onlyIfChanged = false) {
    const data = await api<{ bundles: Bundle[]; defaultWriteTarget?: string; defaultBundle?: string }>("/bundles");
    const target = data.defaultWriteTarget ?? data.defaultBundle ?? "";
    const changed = JSON.stringify(bundles) !== JSON.stringify(data.bundles) || defaultWriteTarget !== target;
    bundles = data.bundles;
    bundlesReady = true;
    defaultWriteTarget = target;
    if (!onlyIfChanged || changed) bundleRevision++;
  }
  async function refreshHomeContext() {
    await Promise.all([
      refreshPending(),
      refreshBundles(true).catch(() => {
        bundlesReady = false;
      }),
    ]);
  }
  function renamedBundle(event: Event) {
    const { old, name } = (event as CustomEvent<{ old: string; name: string }>).detail;
    // Return Library to a live location; do not leave its retained reader using the old identity.
    pages = { ...pages, Library: { route: "files", query: new URLSearchParams({ bundle: name }) } };
    try {
      for (const key of Object.keys(sessionStorage).filter((key) => key.startsWith("akm-desktop-editor:"))) {
        const nextKey = key
          .replace("akm-desktop-editor:" + old + "//", "akm-desktop-editor:" + name + "//")
          .replace("akm-desktop-editor:" + old + "/", "akm-desktop-editor:" + name + "/");
        const draft = JSON.parse(sessionStorage.getItem(key)!);
        if (draft.bundle === old) draft.bundle = name;
        sessionStorage.setItem(nextKey, JSON.stringify(draft));
        if (nextKey !== key) sessionStorage.removeItem(key);
      }
    } catch {
      /* Existing drafts remain available if browser storage is unavailable. */
    }
  }
  async function load() {
    error = "";
    const outcomes = await Promise.allSettled([
      api<NonNullable<typeof metadata>>("/desktop").then((value) => (metadata = value)),
      refreshBundles(),
    ]);
    error = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => (outcome as PromiseRejectedResult).reason?.message ?? "Could not load workspace details.")
      .join(" ");
    ready = true;
    void refreshPending();
  }
  function applyTheme() {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("akm-ui-theme", theme);
    } catch {
      /* Window preference still works. */
    }
    window.dispatchEvent(new Event("akm-theme"));
  }
  async function saveTheme() {
    applyTheme();
    themeError = "";
    try {
      await api("/desktop/preferences", {}, { theme });
    } catch {
      themeError = "Appearance changed for this window, but could not be saved.";
    }
  }
  async function readRoute() {
    const next = location.hash.startsWith("#/") ? location.hash : "#/home";
    const [path, search = ""] = next.slice(2).split("?");
    const route = path || "home";
    const selected = sectionFor(route);
    if (next === shownHash && visited.has(selected)) return;
    positions.set(shownHash, window.scrollY);
    const changedSection = section !== selected;
    section = selected;
    shownHash = next;
    pages = { ...pages, [selected]: { route, query: new URLSearchParams(search) } };
    visited = new Set([...visited, selected]);
    await tick();
    if (changedSection) {
      window.scrollTo(0, positions.get(next) ?? 0);
      const heading = main?.querySelector<HTMLElement>("div:not([hidden]) h1");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
    if (selected === "Review" || selected === "Home") void refreshPending();
  }
  function followLink(event: MouseEvent) {
    if (event.defaultPrevented || event.button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const link = (event.target as Element)?.closest<HTMLAnchorElement>("a[href]");
    if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname || !url.hash.startsWith("#/")) return;
    event.preventDefault();
    void navigate(url.href).catch((cause) => {
      error = (cause as Error).message;
    });
  }
  async function shortcuts(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      try {
        if (library) await library.openSearch();
        else await navigate("#/search");
        await tick();
        main.querySelector<HTMLInputElement>('.library-page input[type="search"]')?.focus();
      } catch (cause) {
        error = (cause as Error).message;
      }
    }
  }
  onMount(() => {
    try {
      const saved = localStorage.getItem("akm-ui-theme");
      if (saved && ["light", "dark", "system"].includes(saved)) theme = saved;
    } catch {
      /* System is the default. */
    }
    applyTheme();
    void readRoute();
    void load();
    const initialTheme = theme;
    void api<{ theme: string }>("/desktop/preferences")
      .then((saved) => {
        if (theme === initialTheme) {
          theme = saved.theme;
          applyTheme();
        }
      })
      .catch(() => {
        themeError = "Saved appearance could not be loaded.";
      });
    // Manual URL edits also get valid Kit history metadata. Ordinary app
    // navigation uses navigate(), so no native hash/history bookkeeping leaks.
    const hashChanged = () => {
      if (pendingNavigation || navigating.to?.url.href === location.href) return;
      if (!navigating.type && location.hash === shownHash) return;
      void navigate(location.href, true).catch((cause) => {
        error = (cause as Error).message;
      });
    };
    const unload = (event: BeforeUnloadEvent) => {
      let drafts = hasUnsaved();
      try {
        drafts = drafts || Object.keys(sessionStorage).some((key) => key.startsWith("akm-desktop-editor:"));
      } catch {
        /* use in-memory fallback */
      }
      if (drafts) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    // Kit already initializes history. A redundant startup goto can overwrite
    // a newer deep link while the initial workspace requests are in flight.
    document.addEventListener("click", followLink, true);
    window.addEventListener("hashchange", hashChanged);
    window.addEventListener("beforeunload", unload);
    window.addEventListener("keydown", shortcuts);
    window.addEventListener("akm-proposals-changed", refreshPending);
    window.addEventListener("akm-bundle-renamed", renamedBundle);
    return () => {
      document.removeEventListener("click", followLink, true);
      window.removeEventListener("hashchange", hashChanged);
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("keydown", shortcuts);
      window.removeEventListener("akm-proposals-changed", refreshPending);
      window.removeEventListener("akm-bundle-renamed", renamedBundle);
    };
  });
</script>

<svelte:head><title>{section} · AKM Desktop</title><meta name="color-scheme" content="light dark" /></svelte:head>
<a href="#main" class="skip-link" on:click|preventDefault={() => main.focus()}>Skip to content</a>
<div
  class="desktop-shell"
  class:library-active={section === "Library"}
  class:workspace-active={section === "Review" ||
    (section === "Library" && ["files", "edit", "new", "new-sensitive", "compare"].includes(pages.Library.route))}
>
  <header class="desktop-topbar">
    <a class="brand" href={href("Home")} aria-label="AKM home">akm<span aria-hidden="true">.</span></a>
    <nav aria-label="Primary navigation">
      {#each sections as item}
        <a href={href(item)} aria-current={section === item ? "page" : undefined}
          >{item}{#if item === "Review" && pendingCount !== null && pendingCount > 0}<span
              class="nav-count"
              aria-label={pendingCount + " pending proposals"}>{pendingCount}</span
            >{/if}</a
        >
      {/each}
    </nav>
    <span class="host"
      >{metadata?.hostname ?? "This computer"} <span class="version">AKM {metadata?.akmVersion ?? "…"}</span></span
    >
  </header>
  <main id="main" tabindex="-1" bind:this={main}>
    {#if error}<div class="notice notice-fail" role="alert">
        <p>{error}</p>
        <button class="btn-secondary" on:click={load}>Retry workspace details</button>
      </div>{/if}
    {#if ready}
      {#if visited.has("Home")}<div hidden={section !== "Home"}>
          <Home
            active={section === "Home"}
            {bundles}
            {bundlesReady}
            {defaultWriteTarget}
            {pendingCount}
            refreshContext={refreshHomeContext}
          />
        </div>{/if}
      {#if visited.has("Library")}<div class="library-page" hidden={section !== "Library"}>
          <Library
            bind:this={library}
            {bundles}
            {defaultWriteTarget}
            {bundleRevision}
            route={pages.Library.route}
            query={pages.Library.query}
          />
        </div>{/if}
      {#if visited.has("Review")}<div class="review-page-shell" hidden={section !== "Review"}>
          <Review route={pages.Review.route} query={pages.Review.query} />
        </div>{/if}
      {#if visited.has("Activity")}<div hidden={section !== "Activity"}>
          <Activity route={pages.Activity.route} query={pages.Activity.query} />
        </div>{/if}
      {#if visited.has("Settings")}<div hidden={section !== "Settings"}>
          <Settings {bundles} {refreshBundles} route={pages.Settings.route} query={pages.Settings.query} />
        </div>{/if}
    {:else}<p class="state" role="status">Opening your workspace…</p>{/if}
  </main>
  <footer class="desktop-footer">
    <span class="build-label" title={metadata?.commit ? `Build ${metadata.commit}` : undefined}
      >AKM Desktop <span>{metadata?.version ?? ""}</span
      >{#if metadata?.commit && metadata.commit !== "development"}<span class="build-commit">{metadata.commit}</span
        >{/if}</span
    >
    <label class="theme-picker"
      >Appearance<select aria-label="Appearance" bind:value={theme} on:change={saveTheme}
        ><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option
        ></select
      ></label
    >
  </footer>
</div>
<dialog
  class="leave-editor-dialog"
  bind:this={leaveDialog}
  aria-labelledby="leave-editor-title"
  on:cancel|preventDefault={stayInEditor}
>
  <h2 id="leave-editor-title">Leave this draft?</h2>
  <p>Your unsaved changes stay in this window. Reopen this editor to continue, or save before leaving.</p>
  <div class="btn-row">
    <button class="btn-secondary" on:click={stayInEditor}>Stay in editor</button><button on:click={leaveAndKeep}
      >Leave and keep draft</button
    >
  </div>
</dialog>
{#if themeError}<p role="status" class="notice notice-warn">{themeError}</p>{/if}
<div id="route-status" class="sr-only" role="status" aria-live="polite"></div>

<style>
  .build-label {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .build-commit {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--faint);
    padding-left: 8px;
    border-left: 1px solid var(--border);
  }
  .leave-editor-dialog {
    max-width: 460px;
    width: calc(100vw - 32px);
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
  }
  .leave-editor-dialog::backdrop {
    background: rgb(0 0 0 / 0.4);
  }
  .leave-editor-dialog h2 {
    margin: 0 0 12px;
  }
  .leave-editor-dialog p {
    margin: 0 0 24px;
    line-height: 1.6;
  }
  .leave-editor-dialog .btn-row {
    justify-content: flex-end;
    flex-wrap: wrap;
  }
</style>
