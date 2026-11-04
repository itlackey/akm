<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, tick, type Snippet } from "svelte";
  import { afterNavigate, beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { api } from "../lib/client";
  import { hasStoredDrafts, hasUnsaved } from "../lib/drafts";
  import { navigate } from "../lib/navigation";
  import { applyTheme, refreshBundles, refreshPending, workspace } from "../lib/state/workspace.svelte";
  import "../lib/ui/tokens.css";
  import "../lib/ui/base.css";
  import "../lib/ui/layout.css";
  import "../lib/ui/components.css";
  import "../lib/ui/pages.css";
  import "../lib/ui/utilities.css";
  import "../lib/desktop.css";

  let { children }: { children: Snippet } = $props();

  const sections = [
    { name: "Home", prefix: "" },
    { name: "Library", prefix: "library" },
    { name: "Review", prefix: "review" },
    { name: "Activity", prefix: "activity" },
    { name: "Settings", prefix: "settings" },
  ] as const;
  type Metadata = { hostname: string; akmVersion: string; version: string; commit?: string };

  let ready = $state(false);
  let error = $state("");
  let themeError = $state("");
  let metadata = $state<Metadata | null>(null);
  let main: HTMLElement;
  let leaveDialog: HTMLDialogElement;
  let pending: { href: string; delta?: number } | null = null;
  let approved = "";
  let editorFocus: HTMLElement | null = null;

  const prefix = $derived(page.url.pathname.split("/")[1] ?? "");
  const section = $derived(sections.find((item) => item.prefix === prefix) ?? sections[0]);
  // First-run setup is reached from Home and Settings, not from the bar, so no section is current there.
  const current = $derived(prefix === "setup" ? undefined : section);
  const view = $derived(page.url.pathname.split("/")[2] ?? "");
  const editing = $derived(prefix === "library" && ["edit", "new"].includes(view));
  const workspaceActive = $derived(
    prefix === "review" ||
      (prefix === "library" && ["files", "edit", "new", "new-sensitive", "compare"].includes(view)),
  );

  beforeNavigate((navigation) => {
    if (approved && navigation.to?.url.href === approved) {
      approved = "";
      return;
    }
    if (!editing || !hasUnsaved()) return;
    if (navigation.to?.url.href === page.url.href && !navigation.willUnload) return;
    navigation.cancel();
    if (navigation.willUnload || pending || !navigation.to) return;
    pending = {
      href: navigation.to.url.href,
      ...(navigation.type === "popstate" ? { delta: navigation.delta } : {}),
    };
    editorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => leaveDialog?.showModal());
  });
  afterNavigate((navigation) => {
    // A completed save may open its reader while a leave prompt is pending.
    // Once there is no unsaved work, that prompt no longer describes reality.
    if (pending && !hasUnsaved()) {
      pending = null;
      approved = "";
      leaveDialog?.close();
    }
    if (section.prefix) workspace.sectionHref[section.name] = page.url.pathname + page.url.search;
    if (section.name === "Review" || section.name === "Home") void refreshPending();
    if (navigation.type !== "enter" && navigation.from?.url.pathname.split("/")[1] !== prefix) {
      void tick().then(() => {
        const heading = main?.querySelector<HTMLElement>("h1");
        if (heading) {
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
        }
      });
    }
  });

  function stayInEditor() {
    pending = null;
    leaveDialog.close();
    editorFocus?.focus({ preventScroll: true });
  }
  async function leaveAndKeep() {
    const destination = pending;
    if (!destination) return;
    pending = null;
    leaveDialog.close();
    approved = destination.href;
    // Kit has already cancelled/restored the original traversal. Retry the same
    // user-requested history delta, letting Kit own the history bookkeeping.
    if (destination.delta) history.go(destination.delta);
    else
      try {
        await navigate(destination.href);
      } catch (cause) {
        approved = "";
        error = (cause as Error).message;
      }
  }
  async function load() {
    error = "";
    const outcomes = await Promise.allSettled([
      api<Metadata>("/desktop").then((value) => (metadata = value)),
      refreshBundles(),
    ]);
    error = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => (outcome as PromiseRejectedResult).reason?.message ?? "Could not load workspace details.")
      .join(" ");
    ready = true;
    void refreshPending();
  }
  async function saveTheme() {
    applyTheme();
    themeError = "";
    try {
      await api("/desktop/preferences", {}, { theme: workspace.theme });
    } catch {
      themeError = "Appearance changed for this window, but could not be saved.";
    }
  }
  async function shortcuts(event: KeyboardEvent) {
    // The Library page handles its own search shortcut, which keeps the current results.
    if (event.defaultPrevented || prefix === "library") return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      try {
        await navigate("/library/search");
        await tick();
        main.querySelector<HTMLInputElement>('.library-page input[type="search"]')?.focus();
      } catch (cause) {
        error = (cause as Error).message;
      }
    }
  }
  function unload(event: BeforeUnloadEvent) {
    if (hasUnsaved() || hasStoredDrafts()) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  onMount(() => {
    try {
      const saved = localStorage.getItem("akm-ui-theme");
      if (saved && ["light", "dark", "system"].includes(saved)) workspace.theme = saved;
    } catch {
      /* System is the default. */
    }
    applyTheme();
    void load();
    const initialTheme = workspace.theme;
    void api<{ theme: string }>("/desktop/preferences")
      .then((saved) => {
        if (workspace.theme === initialTheme) {
          workspace.theme = saved.theme;
          applyTheme();
        }
      })
      .catch(() => {
        themeError = "Saved appearance could not be loaded.";
      });
  });
</script>

<svelte:head
  ><title>{prefix === "setup" ? "Set up" : section.name} · AKM Desktop</title><meta
    name="color-scheme"
    content="light dark"
  /></svelte:head
>
<svelte:window onkeydown={shortcuts} onbeforeunload={unload} />
<a
  href="#main"
  class="skip-link"
  onclick={(event) => {
    event.preventDefault();
    main.focus();
  }}>Skip to content</a
>
<div class="desktop-shell" class:library-active={prefix === "library"} class:workspace-active={workspaceActive}>
  <header class="desktop-topbar">
    <a class="brand" href="/" aria-label="AKM home">akm<span aria-hidden="true">.</span></a>
    <nav aria-label="Primary navigation">
      {#each sections as item}
        <a href={workspace.sectionHref[item.name]} aria-current={current === item ? "page" : undefined}
          >{item.name}{#if item.name === "Review" && workspace.pendingCount !== null && workspace.pendingCount > 0}<span
              class="nav-count"
              aria-label={workspace.pendingCount + " pending proposals"}>{workspace.pendingCount}</span
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
        <button class="btn-secondary" onclick={load}>Retry workspace details</button>
      </div>{/if}
    {#if ready}
      {@render children()}
    {:else}<p class="state" role="status">Opening your workspace…</p>{/if}
  </main>
  <footer class="desktop-footer">
    <span class="build-label" title={metadata?.commit ? `Build ${metadata.commit}` : undefined}
      >AKM Desktop <span>{metadata?.version ?? ""}</span
      >{#if metadata?.commit && metadata.commit !== "development"}<span class="build-commit">{metadata.commit}</span
        >{/if}</span
    >
    <label class="theme-picker"
      >Appearance<select aria-label="Appearance" bind:value={workspace.theme} onchange={saveTheme}
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
  oncancel={(event) => {
    event.preventDefault();
    stayInEditor();
  }}
>
  <h2 id="leave-editor-title">Leave this draft?</h2>
  <p>Your unsaved changes stay in this window. Reopen this editor to continue, or save before leaving.</p>
  <div class="btn-row">
    <button class="btn-secondary" onclick={stayInEditor}>Stay in editor</button><button onclick={leaveAndKeep}
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
