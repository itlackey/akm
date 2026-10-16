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

/** Bun text imports of the `akm ui` client files: `import js from "./app.js" with { type: "text" }` */
declare module "*/assets/ui/app.js" {
  const content: string;
  export default content;
}

/** Bun text imports of the `akm ui` stylesheet: `import css from "./styles.css" with { type: "text" }` */
declare module "*/assets/ui/styles.css" {
  const content: string;
  export default content;
}
