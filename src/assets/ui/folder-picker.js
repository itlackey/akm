// A folder picker: a browser page cannot read the path of a folder the user picks, so this asks the local server for
// the sub-folders of one path at a time and returns the one chosen.

import { api, html, mount } from "./lib.js";

const FOLDER_ICON = html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h6l2 2h10v10H3z"/></svg>`;

/** `child` relative to `root`, as a posix path; "" for the root itself. */
function relativeTo(root, child) {
  return child
    .slice(root.length)
    .replace(/^[\\/]+/, "")
    .replaceAll("\\", "/");
}

/** The folder name at the end of `folder`. */
const baseName = (folder) => folder.split(/[\\/]/).filter(Boolean).pop() ?? "";

/**
 * Open the picker and resolve with the chosen folder, or null when it is cancelled.
 * `start` is the folder shown first (default: the home folder). With `root`, the picker stays inside that folder
 * and resolves with the choice relative to it ("" for the root itself).
 */
export function pickFolder({ start = "", root = null, title = "Choose a folder" } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "folder-picker";
    dialog.setAttribute("aria-labelledby", "fp-title");
    document.body.append(dialog);
    let current = null;
    let showHidden = false;
    let chosen = null;

    async function open(target) {
      try {
        current = await api("/api/fs/folders", { path: target, hidden: showHidden ? "1" : "" });
        draw(null);
      } catch (error) {
        draw(error instanceof Error ? error.message : String(error));
      }
    }

    function draw(problem) {
      const canGoUp = Boolean(current?.parent) && (root === null || current.path !== root);
      const where = !current
        ? ""
        : root === null
          ? current.path
          : `${[baseName(root), relativeTo(root, current.path)].filter(Boolean).join("/")}/`;
      mount(
        dialog,
        html`<form method="dialog" class="folder-picker-body">
          <header><h2 id="fp-title">${title}</h2><button type="submit" value="cancel" class="btn-secondary" aria-label="Close">Close</button></header>
          <div class="folder-path"><button type="button" class="btn-secondary" data-up ${canGoUp ? "" : html`disabled`}>Up</button><code class="mono" data-location>${where}</code></div>
          ${problem ? html`<p class="notice notice-warn" role="status">${problem}</p>` : ""}
          <ul class="folder-list" aria-label="Folders">${
            current?.folders.length
              ? current.folders.map(
                  (f) =>
                    html`<li><button type="button" class="folder-row" data-open="${f.path}">${FOLDER_ICON}${f.name}</button></li>`,
                )
              : html`<li class="muted folder-empty">${problem ? "" : "No folders here."}</li>`
          }</ul>
          ${current?.truncated ? html`<p class="muted small">Only the first folders are listed. Type the path instead.</p>` : ""}
          <footer>
            <label class="check-label"><input type="checkbox" role="switch" class="switch" data-hidden ${showHidden ? html`checked` : ""}> Show hidden folders</label>
            <button type="submit" value="cancel" class="btn-secondary">Cancel</button>
            <button type="submit" value="use" ${current ? "" : html`disabled`}>Use this folder</button>
          </footer>
        </form>`,
      );
    }

    dialog.addEventListener("click", (event) => {
      const row = event.target.closest("[data-open]");
      if (row) open(row.dataset.open);
      else if (event.target.closest("[data-up]") && current?.parent) open(current.parent);
    });
    dialog.addEventListener("change", (event) => {
      if (!event.target.matches("[data-hidden]")) return;
      showHidden = event.target.checked;
      open(current?.path ?? "");
    });
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "use" && current)
        chosen = root === null ? current.path : relativeTo(root, current.path);
      dialog.remove();
      resolve(chosen);
    });

    draw(null);
    dialog.showModal();
    open(root ?? start);
  });
}

/**
 * Make every `[data-browse-folder="<input id>"]` button under `scope` open the picker for that input.
 * `options(button)` may return `{ root }` to keep a button's picker inside one folder.
 */
export function wireFolderBrowse(scope, options = () => ({})) {
  for (const button of scope.querySelectorAll("[data-browse-folder]")) {
    button.addEventListener("click", async () => {
      const input = scope.querySelector(`#${button.dataset.browseFolder}`);
      if (!input) return;
      const { root = null } = options(button) ?? {};
      const typed = input.value.trim();
      const start = root === null && (typed.startsWith("/") || typed.startsWith("~")) ? typed : "";
      const title = root === null ? "Choose a folder" : "Choose a folder in the bundle";
      const picked = await pickFolder({ start, root, title });
      if (picked === null) return;
      input.value = picked;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
  }
}
