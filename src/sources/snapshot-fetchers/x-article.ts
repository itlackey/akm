// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parse } from "node-html-parser";

/**
 * Reads X Articles and post text out of the JSON-compatible relay payload a
 * public X page embeds in its scripts. Page code is never executed; fields are
 * read as bounded strings from the serialized objects.
 */

export interface PublicXArticle {
  title: string;
  body: string;
}

interface SerializedArticle extends PublicXArticle {
  restId: string;
}

interface SerializedPayload {
  source: string;
  code: Uint8Array;
}

interface SerializedObject extends SerializedPayload {
  start: number;
  end: number;
}

const MAX_RELAY_OBJECT_CANDIDATES = 16;
const EXECUTABLE_SCRIPT_TYPES = new Set([
  "module",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
const EXECUTABLE_SCRIPT_LANGUAGES = new Set([
  "ecmascript",
  "javascript",
  "javascript1.0",
  "javascript1.1",
  "javascript1.2",
  "javascript1.3",
  "javascript1.4",
  "javascript1.5",
  "jscript",
  "livescript",
]);
const CONTROL_CONDITION_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);
const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function closesControlCondition(source: string, code: Uint8Array, closeIndex: number): boolean {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    if (code[i] !== 1) continue;
    const char = source[i] ?? "";
    if (char === ")") depth += 1;
    else if (char === "(") {
      depth -= 1;
      if (depth !== 0) continue;
      let end = i - 1;
      while (end >= 0 && (code[end] !== 1 || /\s/.test(source[end] ?? ""))) end -= 1;
      let start = end;
      while (start >= 0 && code[start] === 1 && /[A-Za-z]/.test(source[start] ?? "")) start -= 1;
      return CONTROL_CONDITION_KEYWORDS.has(source.slice(start + 1, end + 1));
    }
  }
  return false;
}

function startsRegexLiteral(source: string, code: Uint8Array, slashIndex: number): boolean {
  let previous = slashIndex - 1;
  while (previous >= 0 && (code[previous] !== 1 || /\s/.test(source[previous] ?? ""))) previous -= 1;
  if (previous < 0) return true;
  const previousChar = source[previous] ?? "";
  if (previousChar === ")" && closesControlCondition(source, code, previous)) return true;
  if (previousChar === "}") return true;
  if (/[([{:;,=!?&|+*%^~<>-]/.test(previousChar)) return true;
  if (!/[A-Za-z]/.test(previousChar)) return false;
  let start = previous;
  while (start > 0 && /[A-Za-z]/.test(source[start - 1] ?? "")) start -= 1;
  return REGEX_PREFIX_KEYWORDS.has(source.slice(start, previous + 1));
}

function executableCodeMask(source: string): Uint8Array {
  const code = new Uint8Array(source.length);
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        code[i] = 1;
      }
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "[") regexClass = true;
      else if (char === "]") regexClass = false;
      else if (char === "/" && !regexClass) regex = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (source.startsWith("<!--", i)) {
      lineComment = true;
      i += 3;
      continue;
    }
    if (source.startsWith("-->", i) && /^\s*$/.test(source.slice(source.lastIndexOf("\n", i - 1) + 1, i))) {
      lineComment = true;
      i += 2;
      continue;
    }
    if (char === "/" && startsRegexLiteral(source, code, i)) {
      regex = true;
      regexClass = false;
      continue;
    }
    // Relay state uses JSON-compatible strings, never template literals. Mask
    // the remainder rather than partially interpreting nested `${...}` code.
    if (char === "`") break;
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    code[i] = 1;
  }
  return code;
}

function serializedScriptPayload(html: string): SerializedPayload | null {
  let root: ReturnType<typeof parse>;
  try {
    root = parse(html, { comment: false });
  } catch {
    return null;
  }
  const scripts: SerializedPayload[] = [];
  for (const script of root.querySelectorAll("script")) {
    if (script.hasAttribute("src") || script.hasAttribute("nomodule")) continue;
    const scriptType = (script.getAttribute("type") ?? "").trim().toLowerCase();
    if (scriptType && !EXECUTABLE_SCRIPT_TYPES.has(scriptType)) continue;
    const scriptLanguage = (script.getAttribute("language") ?? "").trim().toLowerCase();
    if (!scriptType && scriptLanguage && !EXECUTABLE_SCRIPT_LANGUAGES.has(scriptLanguage)) continue;
    let parent = script.parentNode;
    let inert = false;
    while (parent && "tagName" in parent) {
      const tagName = typeof parent.tagName === "string" ? parent.tagName.toLowerCase() : "";
      if (
        [
          "iframe",
          "math",
          "noembed",
          "noframes",
          "noscript",
          "plaintext",
          "style",
          "svg",
          "template",
          "textarea",
          "title",
          "xmp",
        ].includes(tagName)
      ) {
        inert = true;
        break;
      }
      parent = parent.parentNode;
    }
    if (inert) continue;
    const body = script.innerHTML;
    if (body.includes("$R[") || body.includes('__typename:"ArticleEntity"')) {
      scripts.push({ source: body, code: executableCodeMask(body) });
    }
  }
  if (scripts.length === 0) return null;
  const separator = "\0;\n";
  const source = scripts.map((script) => script.source).join(separator);
  const code = new Uint8Array(source.length);
  let offset = 0;
  for (const [index, script] of scripts.entries()) {
    code.set(script.code, offset);
    offset += script.source.length;
    if (index < scripts.length - 1) {
      code.fill(1, offset, offset + separator.length);
      offset += separator.length;
    }
  }
  return { source, code };
}

function readJsonStringAt(value: string, quoteIndex: number): { value: string; end: number } | null {
  if (value[quoteIndex] !== '"') return null;
  let escaped = false;
  for (let i = quoteIndex + 1; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    try {
      const parsed = JSON.parse(value.slice(quoteIndex, i + 1));
      return typeof parsed === "string" ? { value: parsed, end: i + 1 } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readSerializedObjectAt(payload: SerializedPayload, openIndex: number): SerializedObject | null {
  if (payload.source[openIndex] !== "{" || payload.code[openIndex] !== 1) return null;
  let depth = 0;
  for (let i = openIndex; i < payload.source.length; i++) {
    if (payload.code[i] !== 1) continue;
    const char = payload.source[i] ?? "";
    if (char === "\0") return null;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          start: openIndex,
          end: i + 1,
          source: payload.source.slice(openIndex, i + 1),
          code: payload.code.slice(openIndex, i + 1),
        };
      }
    }
  }
  return null;
}

function isRelayAssignment(payload: SerializedPayload, assignmentIndex: number): boolean {
  if (payload.code[assignmentIndex] !== 1 || payload.code[assignmentIndex + 1] !== 1) return false;
  const prefixStart = Math.max(0, assignmentIndex - 40);
  const match = /\$R\[\d+\]$/.exec(payload.source.slice(prefixStart, assignmentIndex));
  if (!match) return false;
  let boundaryIndex = prefixStart + match.index - 1;
  while (boundaryIndex >= 0 && (payload.code[boundaryIndex] !== 1 || /\s/.test(payload.source[boundaryIndex] ?? ""))) {
    boundaryIndex -= 1;
  }
  return boundaryIndex < 0 || /[:,;=({[]/.test(payload.source[boundaryIndex] ?? "");
}

function objectContaining(payload: SerializedPayload, markerIndex: number): SerializedObject | null {
  let assignmentIndex = payload.source.lastIndexOf("={", markerIndex);
  while (assignmentIndex >= 0) {
    if (isRelayAssignment(payload, assignmentIndex)) {
      const object = readSerializedObjectAt(payload, assignmentIndex + 1);
      if (object && object.end > markerIndex) return object;
    }
    assignmentIndex = payload.source.lastIndexOf("={", assignmentIndex - 1);
  }
  return null;
}

function topLevelPropertyValueIndexes(object: SerializedObject, property: string): number[] {
  const indexes: number[] = [];
  let depth = 0;
  for (let i = 0; i < object.source.length; i++) {
    if (object.code[i] !== 1) continue;
    const char = object.source[i] ?? "";
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 1 || !object.source.startsWith(property, i)) continue;
    let beforeIndex = i - 1;
    while (beforeIndex >= 0 && (object.code[beforeIndex] !== 1 || /\s/.test(object.source[beforeIndex] ?? ""))) {
      beforeIndex -= 1;
    }
    const before = object.source[beforeIndex];
    if (before !== "{" && before !== ",") continue;
    let cursor = i + property.length;
    while (/\s/.test(object.source[cursor] ?? "")) cursor += 1;
    if (object.source[cursor] !== ":" || object.code[cursor] !== 1) continue;
    indexes.push(cursor + 1);
  }
  return indexes;
}

function nextExecutableIndex(object: SerializedObject, from: number): number {
  for (let i = from; i < object.source.length; i++) {
    if (object.code[i] === 1 && !/\s/.test(object.source[i] ?? "")) return i;
  }
  return -1;
}

function topLevelStringProperty(object: SerializedObject, property: string): string {
  let valueIndex = topLevelPropertyValueIndexes(object, property).at(-1) ?? -1;
  if (valueIndex < 0) return "";
  while (/\s/.test(object.source[valueIndex] ?? "")) valueIndex += 1;
  const parsed = readJsonStringAt(object.source, valueIndex);
  if (!parsed) return "";
  const delimiterIndex = nextExecutableIndex(object, parsed.end);
  if (delimiterIndex < 0 || (object.source[delimiterIndex] !== "," && object.source[delimiterIndex] !== "}")) return "";
  return parsed.value;
}

function topLevelObjectProperty(object: SerializedObject, property: string): SerializedObject | null {
  const valueIndex = topLevelPropertyValueIndexes(object, property).at(-1) ?? -1;
  if (valueIndex < 0) return null;
  let openIndex = -1;
  for (let i = valueIndex; i < object.source.length; i++) {
    if (object.code[i] !== 1) continue;
    if (object.source[i] === ",") return null;
    if (object.source[i] === "{") {
      openIndex = i;
      break;
    }
  }
  if (openIndex < 0) return null;
  return readSerializedObjectAt(object, openIndex);
}

function findObjectById(payload: SerializedPayload, id: string): SerializedObject | null {
  if (!/^[A-Za-z0-9_:+/=-]{1,512}$/.test(id)) return null;
  const marker = `__id:"${id}"`;
  let from = 0;
  let found: SerializedObject | null = null;
  let candidates = 0;
  while (from < payload.source.length) {
    const index = payload.source.indexOf(marker, from);
    if (index < 0) break;
    if (payload.code[index] !== 1) {
      from = index + marker.length;
      continue;
    }
    const object = objectContaining(payload, index);
    if (object) {
      candidates += 1;
      if (candidates > MAX_RELAY_OBJECT_CANDIDATES) return null;
      if (topLevelStringProperty(object, "__id") === id) {
        if (found && found.start !== object.start) return null;
        found = object;
      }
    }
    from = index + marker.length;
  }
  return found;
}

function articleFromObject(object: SerializedObject): SerializedArticle | null {
  if (topLevelStringProperty(object, "__typename") !== "ArticleEntity") return null;
  const body = topLevelStringProperty(object, "plain_text").trim();
  if (!body) return null;
  return {
    title: topLevelStringProperty(object, "title").replace(/\s+/g, " ").trim(),
    body,
    restId: topLevelStringProperty(object, "rest_id"),
  };
}

function referencedObject(
  payload: SerializedPayload,
  object: SerializedObject,
  property: string,
): SerializedObject | null {
  const reference = topLevelObjectProperty(object, property);
  const id = reference ? topLevelStringProperty(reference, "__ref") : "";
  return id ? findObjectById(payload, id) : null;
}

function serializedArticles(payload: SerializedPayload): SerializedArticle[] {
  const marker = '__typename:"ArticleEntity"';
  const seen = new Set<number>();
  const articles: SerializedArticle[] = [];
  let from = 0;
  let candidates = 0;
  while (from < payload.source.length) {
    const index = payload.source.indexOf(marker, from);
    if (index < 0) break;
    if (payload.code[index] !== 1) {
      from = index + marker.length;
      continue;
    }
    const object = objectContaining(payload, index);
    if (object && !seen.has(object.start)) {
      candidates += 1;
      if (candidates > MAX_RELAY_OBJECT_CANDIDATES) return [];
      seen.add(object.start);
      const article = articleFromObject(object);
      if (article) articles.push(article);
    }
    from = index + marker.length;
  }
  return articles;
}

function articleByRestId(payload: SerializedPayload, articleId: string): SerializedArticle | null {
  const marker = `rest_id:"${articleId}"`;
  let from = 0;
  let found: SerializedArticle | null = null;
  let candidates = 0;
  while (from < payload.source.length) {
    const index = payload.source.indexOf(marker, from);
    if (index < 0) break;
    if (payload.code[index] !== 1) {
      from = index + marker.length;
      continue;
    }
    const object = objectContaining(payload, index);
    if (object) {
      candidates += 1;
      if (candidates > MAX_RELAY_OBJECT_CANDIDATES) return null;
    }
    const article = object ? articleFromObject(object) : null;
    if (article?.restId === articleId) {
      if (found) return null;
      found = article;
    }
    from = index + marker.length;
  }
  return found;
}

export function extractPublicXArticle(
  html: string,
  target?: { postId?: string; articleId?: string },
): PublicXArticle | null {
  const payload = serializedScriptPayload(html);
  if (!payload) return null;
  let article: SerializedArticle | undefined;

  if (target?.articleId) {
    article = articleByRestId(payload, target.articleId) ?? undefined;
  } else if (target?.postId) {
    const encodedId = Buffer.from(`Tweet:${target.postId}`).toString("base64");
    const tweetArticle = findObjectById(payload, `client:${encodedId}:article`);
    const articleResults = tweetArticle ? referencedObject(payload, tweetArticle, "article_results") : null;
    const articleObject = articleResults ? referencedObject(payload, articleResults, "result") : null;
    article = articleObject ? (articleFromObject(articleObject) ?? undefined) : undefined;
  } else {
    const articles = serializedArticles(payload);
    if (articles.length === 1) article = articles[0];
  }

  return article ? { title: article.title, body: article.body } : null;
}

export function targetFullText(html: string, postId: string): string {
  const payload = serializedScriptPayload(html);
  if (!payload) return "";
  const encodedId = Buffer.from(`Tweet:${postId}`).toString("base64");
  const details = findObjectById(payload, `client:${encodedId}:details`);
  return details ? topLevelStringProperty(details, "full_text") : "";
}
