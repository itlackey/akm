import indexTemplate from "./index-template.md" with { type: "text" };
import logTemplate from "./log-template.md" with { type: "text" };
import schemaTemplate from "./schema-template.md" with { type: "text" };

export function buildSchemaMd(wikiName: string): string {
  return schemaTemplate.replaceAll("{{WIKI_NAME}}", wikiName);
}

export function buildIndexMd(wikiName: string): string {
  return indexTemplate.replaceAll("{{WIKI_NAME}}", wikiName);
}

export function buildLogMd(wikiName: string): string {
  return logTemplate.replaceAll("{{WIKI_NAME}}", wikiName);
}
