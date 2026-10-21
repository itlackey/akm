// Source-first creation delegates to the existing knowledge import operation; no overwrite mode is exposed.
import { actionForm, api, assetHref, emptyState, html, mount, pageHeader, post } from "./lib.js";
import { markdown, splitFrontmatter } from "./markdown.js";

export async function render(ctx) {
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
