// Source-first creation and revision-checked editing use the existing Markdown writer.
import { actionForm, api, assetHref, emptyState, html, mount, pageHeader, post, setUnsaved } from "./lib.js";
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
  let source = await api("/api/asset/source", { ref });
  const context = { ref: source.ref, bundle: source.ref.split("//")[0] };
  ctx.after.push((root) => {
    const input = root.querySelector('[name="content"]');
    // HTML textarea parsing drops an initial LF, so initialize explicitly.
    input.value = source.content;
    actionForm(
      root,
      ".edit-form",
      async () => {
        try {
          return await post("/api/asset/save", saveBody(source, input.value));
        } catch (error) {
          if (error?.code !== "ASSET_CONTENT_CHANGED") throw error;
          // Take the new revision in place; the draft in the textarea stays as typed.
          source = await api("/api/asset/source", { ref: source.ref });
          throw new Error(
            "The document changed on disk since you opened it. Your draft was kept; saving again will overwrite the newer version.",
          );
        }
      },
      {
        after: () => {
          setUnsaved(false);
          location.hash = assetHref(source.ref);
        },
      },
    );
    const draw = () =>
      mount(root.querySelector("[data-preview]"), markdown(splitFrontmatter(input.value).body, context));
    input.addEventListener("input", () => {
      setUnsaved(input.value !== asTextarea(source.content));
      draw();
    });
    draw();
  });
  return html`${pageHeader("Edit Markdown", source.ref)}
    <p><a href="${assetHref(source.ref)}">Back to document</a></p>
    <p class="muted">Edit the full ${source.type} source, including frontmatter. If the file changes on disk meanwhile, the first save is refused and your draft is kept; saving again overwrites the newer version.</p>
    <form class="edit-form form-grid"><label>Markdown<textarea name="content" rows="20" spellcheck="false">${source.content}</textarea></label>
      <button type="submit">Save Markdown</button><div data-status></div>
    </form><section><h2>Preview</h2><div data-preview></div></section>`;
}
