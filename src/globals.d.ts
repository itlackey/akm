/** Injected at compile time via `bun build --define AKM_VERSION='...'`. */
declare const AKM_VERSION: string;

/** Bun text imports: `import content from "./file.md" with { type: "text" }` */
declare module "*.md" {
  const content: string;
  export default content;
}

/** Bun text imports: `import content from "./file.xml" with { type: "text" }` */
declare module "*.xml" {
  const content: string;
  export default content;
}

/** Bun text imports: `import content from "./file.yaml" with { type: "text" }` */
declare module "*.yaml" {
  const content: string;
  export default content;
}

/** Bun text imports: `import content from "./file.yml" with { type: "text" }` */
declare module "*.yml" {
  const content: string;
  export default content;
}

/** Bun text import of the plugin akm's own OpenCode runtime loads: `import plugin from "./akm-plugin.js" with { type: "text" }` */
declare module "*/assets/opencode/akm-plugin.js" {
  const content: string;
  export default content;
}

/** Bun text imports of the `akm ui` client modules: `import js from "./app.js" with { type: "text" }` (one declaration each: a pattern may hold only one `*`) */
declare module "*/assets/ui/app.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/asset.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/bundles.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/changes.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/charts.js" {
  const content: string;
  export default content;
}
declare module "*/assets/ui/chart-view.js" {
  const content: string;
  export default content;
}
declare module "*/assets/ui/echarts.js" {
  const content: string;
  export default content;
}
declare module "*/assets/ui/overview-charts.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/config.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/diff-view.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/diff.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/editor.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/lib.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/markdown.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/overview.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/proposal-actions.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/proposals.js" {
  const content: string;
  export default content;
}

declare module "*/assets/ui/search.js" {
  const content: string;
  export default content;
}

/** Bun text imports of the `akm ui` stylesheet: `import css from "./styles.css" with { type: "text" }` */
declare module "*/assets/ui/styles.css" {
  const content: string;
  export default content;
}
