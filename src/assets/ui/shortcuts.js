// Keyboard shortcuts for the page on screen. A page registers its keys; one document listener runs them, ignores
// typing in a field and any key held with a modifier, and `?` opens a help dialog that lists what this page offers.

import { html, mount } from "./lib.js";

const GLOBAL = [{ key: "?", label: "Show these shortcuts" }];

let active = [];
let listening = false;
let helper = null;

const typing = (target) =>
  target instanceof Element &&
  (target.closest("input, textarea, select, [contenteditable='true']") !== null ||
    target.closest("dialog[open]") !== null);

function closeHelp() {
  helper?.close();
}

function showHelp() {
  if (!helper) {
    helper = document.createElement("dialog");
    helper.className = "shortcut-help";
    helper.setAttribute("aria-labelledby", "shortcut-help-title");
    helper.addEventListener("close", () => {
      helper?.remove();
      helper = null;
    });
    document.body.append(helper);
  }
  const rows = [...active, ...GLOBAL];
  mount(
    helper,
    html`<form method="dialog" class="shortcut-help-body">
      <header><h2 id="shortcut-help-title">Keyboard shortcuts</h2><button type="submit" class="btn-secondary" aria-label="Close">Close</button></header>
      <dl class="shortcut-list">${rows.map((s) => html`<div><dt><kbd>${s.key}</kbd></dt><dd>${s.label}</dd></div>`)}</dl>
    </form>`,
  );
  if (!helper.open) helper.showModal();
}

function onKey(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "?") {
    if (typing(event.target) && !helper) return;
    event.preventDefault();
    if (helper?.open) closeHelp();
    else showHelp();
    return;
  }
  if (typing(event.target)) return;
  const shortcut = active.find((s) => s.key === event.key);
  if (!shortcut) return;
  event.preventDefault();
  shortcut.run(event);
}

/**
 * Register this page's shortcuts: `[{ key, label, run }]`. Registering again replaces the previous page's keys; the
 * returned function removes them.
 */
export function registerShortcuts(shortcuts) {
  // Rendering in a test or any context without a real document has no keys to listen to.
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return () => {};
  active = shortcuts;
  if (!listening) {
    document.addEventListener("keydown", onKey);
    listening = true;
  }
  return () => {
    if (active === shortcuts) active = [];
    closeHelp();
  };
}
