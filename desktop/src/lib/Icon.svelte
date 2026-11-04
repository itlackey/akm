<script lang="ts">
  /** One stroke language for navigation and actions; never font glyphs as icons. */
  export let name:
    | "arrow-left"
    | "arrow-right"
    | "chevron-right"
    | "chevron-down"
    | "search"
    | "folder"
    | "file"
    | "edit"
    | "more"
    | "refresh"
    | "plus"
    | "close"
    | "check"
    | "external"
    | "sliders"
    | "link"
    | "copy"
    | "history"
    | "alert"
    | "warning" = "file";
  export let size = 18;
  const paths: Record<typeof name, string> = {
    "arrow-left": "m12 5-7 7 7 7M5 12h14",
    "arrow-right": "m12 5 7 7-7 7M5 12h14",
    "chevron-right": "m9 5 7 7-7 7",
    "chevron-down": "m5 9 7 7 7-7",
    search: "m16 16 5 5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0",
    folder: "M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
    file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 13h8M8 17h6",
    edit: "m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    refresh: "M20 8a8 8 0 1 0 0 8M20 3v5h-5",
    plus: "M12 5v14M5 12h14",
    alert: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 8v5M12 16h.01",
    warning: "m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0M12 9v4M12 17h.01",
    close: "m6 6 12 12M6 18 18 6",
    check: "m5 12 4 4L19 6",
    external: "M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5",
    sliders: "M4 7h4m4 0h8M4 17h8m4 0h4M8 4v6M16 14v6",
    link: "M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7",
    copy: "M9 9h12v12H9ZM5 15H3V3h12v2",
    history: "M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v5l3 2",
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={name === "more" ? 3 : 1.75}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"><path d={paths[name]} /></svg
>

<style>
  svg {
    display: inline-block;
    flex: none;
    vertical-align: middle;
  }
</style>
