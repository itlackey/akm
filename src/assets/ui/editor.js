// Source-first creation and revision-checked editing use the existing Markdown writer.
import { actionForm, api, assetHref, emptyState, html, mount, pageHeader, post } from "./lib.js";
import { markdown, splitFrontmatter } from "./markdown.js";

export async function render(ctx) {
  const ref = ctx.query.get("ref");
  if (ref) return edit(ctx, ref);
  const data = await api("/api/bundles");
  const writable = data.bundles.filter((b) => b.enabled && b.writable && b.components.some((c) => c.adapter === "akm"));
  ctx.after.push((root) => {
    actionForm(root, ".create-form", (_form, values) => post("/api/knowledge/create", Object.fromEntries(values)), {
      after: (result) => {
        if (result.ref) location.hash = assetHref(result.ref);
        else location.hash = "#/search";
      },
    });
    const form = root.querySelector(".create-form");
    if (form) {
      const draw = () =>
        mount(root.querySelector("[data-preview]"), markdown(splitFrontmatter(form.elements.content.value).body));
      form.elements.content.addEventListener("input", draw);
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

async function edit(ctx, ref) {
  const source = await api("/api/asset/source", { ref });
  ctx.after.push((root) => {
    const input = root.querySelector('[name="content"]');
    // HTML textarea parsing drops an initial LF; its DOM value also normalizes CRLF.
    // Initialize explicitly and preserve the original source for an untouched draft.
    input.value = source.content;
    const initialValue = input.value;
    const usesCrlf = source.content.includes("\r\n") && !/[\r\n]/.test(source.content.replace(/\r\n/g, ""));
    actionForm(
      root,
      ".edit-form",
      (_form, values) => {
        const content = values.get("content");
        return post("/api/asset/save", {
          ref: source.ref,
          revision: source.revision,
          content: content === initialValue ? source.content : usesCrlf ? content.replace(/\r?\n/g, "\r\n") : content,
        });
      },
      {
        after: () => {
          location.hash = assetHref(source.ref);
        },
      },
    );
    const draw = () => mount(root.querySelector("[data-preview]"), markdown(splitFrontmatter(input.value).body));
    input.addEventListener("input", draw);
    draw();
  });
  return html`${pageHeader("Edit Markdown", source.ref)}
    <p><a href="${assetHref(source.ref)}">Back to document</a></p>
    <p class="muted">Edit the full ${source.type} source, including frontmatter. A changed source must be reloaded before saving; a rejected save keeps your draft here.</p>
    <form class="edit-form form-grid"><label>Markdown<textarea name="content" rows="20" spellcheck="false">${source.content}</textarea></label>
      <button type="submit">Save Markdown</button><div data-status></div>
    </form><section><h2>Preview</h2><div data-preview></div></section>`;
}
