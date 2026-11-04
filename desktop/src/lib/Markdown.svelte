<script lang="ts">
  import { markdown, splitFrontmatter } from "./ui/markdown.js";
  export let content = "";
  // Reuse AKM's title suppression only when the body opens with the displayed title.
  export let omitHeading = "";
  export let links: Record<string, string> = {};
  export let ref = "";
  export let bundle = "";
  export let headings: Array<{ line: number; slug: string; text?: string }> = [];
  $: source = splitFrontmatter(content);
  $: skipTitle = source.body.match(/^#[ \t]+([^\n]+)(?:\n|$)/)?.[1]?.trim() === omitHeading ? omitHeading : undefined;
  $: rendered = markdown(source.body, { ref, bundle, links, headings, startLine: source.startLine, skipTitle });
</script>

<div class="markdown">{@html rendered.text}</div>
