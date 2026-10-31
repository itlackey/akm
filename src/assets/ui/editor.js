// Source-first creation and revision-checked editing use the existing Markdown writer.
import { diffSection } from "./diff-view.js";
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
  const ref = ctx.query.get("ref");
  if (ref) return edit(ctx, ref);
  const data = await api("/api/bundles");
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
    <form class="create-form form-grid">
      <label>Bundle<select name="bundle">${writable.map((b) => html`<option value="${b.name}" ${b.name === (data.defaultWriteTarget ?? data.defaultBundle) ? html`selected` : ""}>${b.name}</option>`)}</select></label>
      <label>Name<input name="name" required placeholder="restore-database"></label>
      <label>Subdirectory<input name="path" placeholder="Optional, under knowledge/"></label>
      <label>Markdown<textarea name="content" rows="16" required spellcheck="false"># New document

</textarea></label>
      <button type="submit">Create knowledge</button><div data-status></div>
    </form>
    <section><h2>Preview</h2><div data-preview></div></section>`
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
  const source = await api("/api/asset/source", { ref });
  const returnTo = searchReturn(ctx.query);
  const context = { ref: source.ref, bundle: source.ref.split("//")[0] };
  ctx.after.push((root) => {
    const input = root.querySelector('[name="content"]');
    const recovery = root.querySelector("[data-recovery]");
    const state = root.querySelector("[data-editor-state]");
    const showPreview = (showing) => {
      root.querySelector("[data-preview-panel]").hidden = !showing;
      root.querySelector("[data-source-panel]").hidden = showing;
      const toggle = root.querySelector("[data-preview-toggle]");
      toggle.setAttribute("aria-pressed", String(showing));
      toggle.textContent = showing ? "Edit source" : "Preview";
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
    root.querySelector("[data-preview-toggle]").addEventListener("click", () => {
      showPreview(root.querySelector("[data-preview-panel]").hidden);
    });
    const draw = () =>
      mount(root.querySelector("[data-preview]"), markdown(splitFrontmatter(input.value).body, context));
    input.addEventListener("input", () => {
      setUnsaved(input.value !== asTextarea(source.content));
      state.textContent = latest
        ? "Conflict — your draft is kept"
        : input.value !== asTextarea(source.content)
          ? "Unsaved changes"
          : "No changes";
      draw();
    });
    draw();
  });
  return html`${pageHeader("Edit Markdown", source.ref)}
    <form class="edit-form form-grid">
      <div class="editor-actions"><button type="submit">Save Markdown</button><button type="button" class="btn-secondary" data-preview-toggle aria-pressed="false">Preview</button><a href="${assetHref(source.ref, returnTo)}">Cancel</a><span class="muted small" data-editor-state role="status">No changes</span></div>
      <div data-status></div>
      <label data-source-panel>Markdown<textarea name="content" rows="16" spellcheck="false">${source.content}</textarea></label>
      <section data-preview-panel hidden><h2>Preview</h2><div data-preview></div></section>
    </form><section data-recovery hidden></section>`;
}
