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
