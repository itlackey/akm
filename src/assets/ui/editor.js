// Source-first creation and revision-checked editing use the existing Markdown writer.
import { diffSection } from "./diff-view.js";
import { wireFolderBrowse } from "./folder-picker.js";
import {
  actionForm,
  api,
  assetHref,
  emptyState,
  html,
  mount,
  pageHeader,
  post,
  searchReturn,
  setFlash,
  setUnsaved,
} from "./lib.js";
import { markdown, splitFrontmatter } from "./markdown.js";

export async function render(ctx) {
  const ref = ctx.query.get("ref") || ctx.param;
  if (ref) return edit(ctx, ref);
  const data = await api("/api/bundles");
  // From a search that found nothing: `?q=` names the note, `?name=` sets the file name.
  const wanted = (ctx.query.get("q") ?? "").trim();
  const title = wanted || "New document";
  const slug = wanted
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefillName = ctx.query.get("name") ?? slug;
  const writable = data.bundles.filter((b) => b.enabled && b.writable && b.components.some((c) => c.adapter === "akm"));
  ctx.after.push((root) => {
    actionForm(root, ".create-form", (_form, values) => post("/api/knowledge/create", Object.fromEntries(values)), {
      after: (result) => {
        setUnsaved(false);
        setFlash("Knowledge created.");
        if (result.ref) location.hash = assetHref(result.ref);
        else location.hash = "#/search";
      },
    });
    const form = root.querySelector(".create-form");
    if (form) {
      wireFolderBrowse(root, () => {
        const bundlePath = form.elements.bundle.selectedOptions[0]?.dataset.path;
        return { root: bundlePath ? `${bundlePath.replace(/[\\/]+$/, "")}/knowledge` : null };
      });
      const draw = () =>
        mount(root.querySelector("[data-preview]"), markdown(splitFrontmatter(form.elements.content.value).body));
      form.elements.content.addEventListener("input", draw);
      form.addEventListener("input", () => setUnsaved(true));
      draw();
    }
  });
  return html`${pageHeader("New knowledge", "Write Markdown and optional frontmatter. Existing files are never overwritten.")}
    <p><a href="#/search">Back to search</a></p>
    ${
      writable.length === 0
        ? emptyState(
            "No enabled writable AKM bundle is available.",
            html`Check <a href="#/bundles">bundle settings</a>.`,
          )
        : html`
    <form class="create-form card settings-card">
      <div class="settings-fields">
        <div class="settings-grid">
          <div class="field"><label class="field-label" for="nk-bundle">Bundle</label><select id="nk-bundle" name="bundle">${writable.map((b) => html`<option value="${b.name}" data-path="${b.path ?? ""}" ${b.name === (data.defaultWriteTarget ?? data.defaultBundle) ? html`selected` : ""}>${b.name}</option>`)}</select></div>
          <div class="field"><label class="field-label" for="nk-name">Name</label><input id="nk-name" name="name" required value="${prefillName}" placeholder="restore-database" autocomplete="off" spellcheck="false" aria-describedby="nk-name-hint"><p class="field-hint" id="nk-name-hint">Becomes the file name and the asset's ref. Lowercase letters, numbers and hyphens read best.</p></div>
          <div class="field"><label class="field-label" for="nk-path">Folder</label><div class="field-control"><input id="nk-path" name="path" placeholder="Optional, under knowledge/" autocomplete="off" spellcheck="false"><button type="button" class="btn-secondary" data-browse-folder="nk-path">Browse…</button></div></div>
        </div>
        <div class="compose">
          <div class="field"><label class="field-label" for="nk-content">Markdown</label><textarea id="nk-content" name="content" rows="18" required spellcheck="false"># ${title}

</textarea></div>
          <section class="compose-preview" aria-labelledby="nk-preview"><h2 id="nk-preview" class="field-label">Preview</h2><div class="md-preview" data-preview></div></section>
        </div>
      </div>
      <div class="settings-footer"><span class="muted small">Existing files are never overwritten.</span><div data-status class="settings-status"></div><button type="submit">Create knowledge</button></div>
    </form>`
    }`;
}

// A textarea's value has every line break as LF.
const asTextarea = (content) => content.replace(/\r\n?/g, "\n");

/** The save request for `draft`: an untouched draft sends the exact source; a uniform-CRLF source keeps CRLF. */
function saveBody(source, draft) {
  const usesCrlf = source.content.includes("\r\n") && !/[\r\n]/.test(source.content.replace(/\r\n/g, ""));
  const content =
    draft === asTextarea(source.content) ? source.content : usesCrlf ? draft.replace(/\r?\n/g, "\r\n") : draft;
  return { ref: source.ref, revision: source.revision, content };
}

async function edit(ctx, ref) {
  const returnTo = searchReturn(ctx.query);
  let source;
  try {
    source = await api("/api/asset/source", { ref });
  } catch (error) {
    // Not a dead end: say what is wrong and offer the two ways forward.
    ctx.after.push((root) =>
      root.querySelector("[data-copy-index]")?.addEventListener("click", async (event) => {
        try {
          await navigator.clipboard.writeText("akm index");
          event.currentTarget.textContent = "Copied";
        } catch {
          event.currentTarget.textContent = "Copy failed";
        }
      }),
    );
    return html`${pageHeader("Edit Markdown", ref)}
      <div class="state state-error" role="alert" tabindex="-1"><p class="state-title">The index is out of date for this file.</p>
      <p>${error instanceof Error ? error.message : String(error)}</p>
      <p class="btn-row"><button type="button" data-copy-index>Copy <code>akm index</code></button><a class="btn btn-secondary" href="${assetHref(ref, returnTo)}">Open read-only</a></p></div>`;
  }
  const context = { ref: source.ref, bundle: source.ref.split("//")[0] };
  ctx.after.push((root) => {
    const input = root.querySelector('[name="content"]');
    const recovery = root.querySelector("[data-recovery]");
    const state = root.querySelector("[data-editor-state]");
    // Write and Preview are tabs (WAI-ARIA tabs pattern): one is selected and focusable, the other is reached by arrow keys.
    const showPreview = (showing) => {
      root.querySelector("[data-preview-panel]").hidden = !showing;
      root.querySelector("[data-source-panel]").hidden = showing;
      const preview = root.querySelector("[data-preview-toggle]");
      const write = root.querySelector("[data-write-tab]");
      preview.setAttribute("aria-selected", String(showing));
      preview.setAttribute("tabindex", showing ? "0" : "-1");
      write.setAttribute("aria-selected", String(!showing));
      write.setAttribute("tabindex", showing ? "-1" : "0");
    };
    let latest = null;
    const saved = (result) => {
      setUnsaved(false);
      setFlash(result.unchanged ? "No changes to save." : "Markdown saved.");
      location.hash = assetHref(source.ref, returnTo);
    };
    const conflict = async () => {
      latest = await api("/api/asset/source", { ref: source.ref });
      const diff = diffSection({ before: latest.content, after: input.value });
      mount(
        recovery,
        html`<div class="notice notice-warn"><h2>Review the newer version</h2><p>The document changed on disk. Your draft is kept below. Compare the current disk version with your draft before choosing what to keep.</p>${diff.markup}<p class="btn-row"><button type="button" class="btn-danger" data-overwrite>Overwrite with my draft</button><button type="button" class="btn-secondary" data-keep-draft>Keep editing my draft</button></p><p data-recovery-status role="status"></p></div>`,
      );
      diff.wire?.(recovery);
      recovery.hidden = false;
      state.textContent = "Conflict — review the newer version";
    };
    // HTML textarea parsing drops an initial LF, so initialize explicitly.
    input.value = source.content;
    actionForm(
      root,
      ".edit-form",
      async () => {
        if (latest)
          throw new Error(
            "Review the newer version, then use Overwrite with my draft if you want to replace it. Your draft is kept.",
          );
        try {
          return await post("/api/asset/save", saveBody(source, input.value));
        } catch (error) {
          if (error?.code !== "ASSET_CONTENT_CHANGED") throw error;
          await conflict();
          throw new Error(
            "The document changed on disk since you opened it. Your draft is kept. Review the newer version below.",
          );
        }
      },
      { after: saved },
    );
    recovery.addEventListener("click", async (event) => {
      if (event.target.closest("[data-keep-draft]")) {
        showPreview(false);
        input.focus();
        return;
      }
      const button = event.target.closest("[data-overwrite]");
      if (!button || button.disabled || !latest) return;
      button.disabled = true;
      try {
        saved(await post("/api/asset/save", saveBody(latest, input.value)));
      } catch (error) {
        if (error?.code === "ASSET_CONTENT_CHANGED") await conflict();
        const status = recovery.querySelector("[data-recovery-status]");
        mount(status, html`<span role="alert" class="text-fail">${error.message}</span>`);
      } finally {
        button.disabled = false;
      }
    });
    root.querySelector("[data-preview-toggle]").addEventListener("click", () => showPreview(true));
    root.querySelector("[data-write-tab]").addEventListener("click", () => showPreview(false));
    root.querySelector("[role=tablist]")?.addEventListener("keydown", (event) => {
      const preview = event.key === "ArrowRight" || event.key === "End";
      if (!preview && event.key !== "ArrowLeft" && event.key !== "Home") return;
      event.preventDefault();
      showPreview(preview);
      root.querySelector(preview ? "[data-preview-toggle]" : "[data-write-tab]")?.focus();
    });
    const draw = () =>
      mount(root.querySelector("[data-preview]"), markdown(splitFrontmatter(input.value).body, context));
    input.addEventListener("input", () => {
      setUnsaved(input.value !== asTextarea(source.content));
      const next = latest
        ? "Conflict — your draft is kept"
        : input.value !== asTextarea(source.content)
          ? "Unsaved changes"
          : "No changes";
      // The status is a live region: write it only when it changes, not on every keystroke.
      if (state.textContent !== next) state.textContent = next;
      draw();
    });
    draw();
    // Ctrl or Cmd+S saves here, not the browser's own page-save dialog.
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        input.form?.requestSubmit();
      }
    });
  });
  return html`${pageHeader("Edit Markdown", source.ref)}
    <form class="edit-form form-grid">
      <div class="editor-actions"><button type="submit">Save Markdown</button><a class="btn btn-secondary" href="${assetHref(source.ref, returnTo)}">Cancel</a><span class="muted small" data-editor-state role="status">No changes</span></div>
      <div data-status></div>
      <div class="tabs" role="tablist" aria-label="Editor view"><button type="button" class="tab" role="tab" id="tab-write" aria-selected="true" aria-controls="panel-write" data-write-tab>Write</button><button type="button" class="tab" role="tab" id="tab-preview" aria-selected="false" aria-controls="panel-preview" tabindex="-1" data-preview-toggle>Preview</button></div>
      <div data-source-panel role="tabpanel" id="panel-write" aria-labelledby="tab-write"><label>Markdown<textarea name="content" rows="16" spellcheck="false">${source.content}</textarea></label></div>
      <section data-preview-panel role="tabpanel" id="panel-preview" aria-labelledby="tab-preview" hidden><h2>Preview</h2><div data-preview></div></section>
    </form><section data-recovery hidden></section>`;
}
