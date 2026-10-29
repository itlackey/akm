// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parse } from "node-html-parser";
import { ResponseTooLargeError, readBodyWithByteCap } from "../../core/common";
import { warn } from "../../core/warn";
import { avoidReservedBasename, coerceString, escapeMarkdownStructure } from "./fetcher-util";
import { fetchGuardedResponse, fetchPinnedJson } from "./host-guard";
import rssFetcher from "./rss";
import type { FetcherContext, WikiSnapshotFetcher, WikiSnapshotResult } from "./types";

/**
 * X / Twitter snapshot fetcher.
 *
 * Profiles retain the API-v2 -> RSS-template strategy. Posts first inspect the
 * public page for an embedded Article, then use exact API-v2 lookup when a token
 * is available, and finally use public Open Graph post text. Public page code is
 * never executed; Article fields are read as bounded JSON-compatible strings.
 */

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
const X_API_BASE = "https://api.x.com/2";
const DEFAULT_TWEET_LIMIT = 50;
const X_BYTE_CAP = 4 * 1024 * 1024;
const X_BODY_TIMEOUT_MS = 30_000;
const X_PAGE_BYTE_CAP = 5 * 1024 * 1024;

/** Reserved x.com paths that are not user profiles. */
const RESERVED_X_PATHS = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "search",
  "settings",
  "i",
  "intent",
  "share",
  "compose",
  "login",
  "signup",
  "about",
  "tos",
  "privacy",
]);

export type XResource =
  | { kind: "profile"; username: string }
  | { kind: "status"; postId: string; usernameHint?: string }
  | { kind: "article"; articleId: string };

type XContentResource = Exclude<XResource, { kind: "profile" }>;

function validXUsername(value: string | undefined): string | null {
  const username = value?.trim().replace(/^@/, "") ?? "";
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) return null;
  if (RESERVED_X_PATHS.has(username.toLowerCase())) return null;
  return username;
}

function validXId(value: string | undefined): string | null {
  return value && /^[0-9]{1,19}$/.test(value) ? value : null;
}

export function extractXResource(url: URL): XResource | null {
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length === 1) {
    const username = validXUsername(segments[0]);
    return username ? { kind: "profile", username } : null;
  }

  if (segments.length === 3 && ["status", "statuses"].includes(segments[1]?.toLowerCase() ?? "")) {
    const usernameHint = validXUsername(segments[0]);
    const postId = validXId(segments[2]);
    if (usernameHint && postId) return { kind: "status", postId, usernameHint };
  }

  if (segments[0]?.toLowerCase() === "i") {
    const resourceType = segments[1]?.toLowerCase();
    const id = validXId(segments[2]);
    if (segments.length === 3 && resourceType === "status" && id) return { kind: "status", postId: id };
    if (segments.length === 3 && resourceType === "article" && id) return { kind: "article", articleId: id };
    const webPostId = validXId(segments[3]);
    if (segments.length === 4 && resourceType === "web" && segments[2]?.toLowerCase() === "status" && webPostId) {
      return { kind: "status", postId: webPostId };
    }
  }

  return null;
}

export function extractXUsername(url: URL): string | null {
  const resource = extractXResource(url);
  return resource?.kind === "profile" ? resource.username : null;
}

/** Secret ref consulted when `X_BEARER_TOKEN` is not in the environment. */
export const X_BEARER_TOKEN_SECRET_REF = "secrets/x-bearer-token";

export function resolveXBearerToken(context?: Pick<FetcherContext, "resolveSecret">): string | null {
  const fromEnv = process.env.X_BEARER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return context?.resolveSecret?.(X_BEARER_TOKEN_SECRET_REF) || null;
  } catch {
    return null;
  }
}

interface XTweet {
  id: string;
  text: string;
  createdAt: string;
}

interface XPost extends XTweet {
  username: string;
}

interface PublicXArticle {
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

async function xApiJson(url: string, token: string, context: FetcherContext): Promise<Record<string, unknown> | null> {
  return (await fetchPinnedJson(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "akm-cli x fetcher",
    },
    byteCap: X_BYTE_CAP,
    bodyTimeoutMs: X_BODY_TIMEOUT_MS,
    timeoutMs: context.timeoutMs,
    signal: context.signal,
  })) as Record<string, unknown> | null;
}

async function fetchProfileViaApi(username: string, token: string, context: FetcherContext): Promise<XTweet[] | null> {
  const lookup = await xApiJson(`${X_API_BASE}/users/by/username/${encodeURIComponent(username)}`, token, context);
  const userId = coerceString((lookup?.data as { id?: unknown } | undefined)?.id);
  if (!userId) return null;

  const timeline = await xApiJson(
    `${X_API_BASE}/users/${encodeURIComponent(userId)}/tweets` +
      `?max_results=${DEFAULT_TWEET_LIMIT}&tweet.fields=created_at`,
    token,
    context,
  );
  const data = timeline?.data;
  if (!Array.isArray(data)) return null;

  return data.map((raw) => {
    const tweet = (raw ?? {}) as Record<string, unknown>;
    return {
      id: validXId(coerceString(tweet.id)) ?? "",
      text: coerceString(tweet.text),
      createdAt: toIsoDate(coerceString(tweet.created_at)),
    };
  });
}

async function fetchPostViaApi(
  postId: string,
  usernameHint: string | undefined,
  token: string,
  context: FetcherContext,
): Promise<XPost | null> {
  const params = new URLSearchParams({
    "tweet.fields": "author_id,created_at,note_tweet",
    expansions: "author_id",
    "user.fields": "username",
  });
  const response = await xApiJson(`${X_API_BASE}/tweets/${encodeURIComponent(postId)}?${params}`, token, context);
  const data = response?.data as Record<string, unknown> | undefined;
  if (!data) return null;
  if (coerceString(data.id) !== postId) return null;
  const noteTweet = data.note_tweet as Record<string, unknown> | undefined;
  const text = coerceString(noteTweet?.text) || coerceString(data.text);
  if (!text) return null;

  const authorId = coerceString(data.author_id);
  const users = (response?.includes as { users?: unknown } | undefined)?.users;
  const author = Array.isArray(users)
    ? users.find((raw) => coerceString((raw as Record<string, unknown>)?.id) === authorId)
    : undefined;
  const username =
    validXUsername(coerceString((author as Record<string, unknown> | undefined)?.username)) || usernameHint || "";
  return {
    id: postId,
    text,
    createdAt: toIsoDate(coerceString(data.created_at)),
    username,
  };
}

function toIsoDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function renderProfileMarkdown(username: string, tweets: XTweet[]): string {
  const sections: string[] = [];
  for (const tweet of tweets) {
    if (!tweet.text) continue;
    const when = tweet.createdAt ? new Date(tweet.createdAt) : null;
    const iso = when && !Number.isNaN(when.getTime()) ? when.toISOString() : "";
    sections.push(`## ${iso || "(undated)"}`, "", escapeXPlainText(tweet.text), "");
    if (tweet.id) sections.push(`https://x.com/${username}/status/${tweet.id}`, "");
  }
  return sections.join("\n").trimEnd();
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

function escapeXPlainText(value: string): string {
  const inlineSafe = value
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/([[\]`])/g, "\\$1")
    .replace(/<(?=[a-zA-Z/!?])/g, "&lt;");
  return escapeMarkdownStructure(inlineSafe);
}

function metaContent(root: ReturnType<typeof parse>, name: "og:title" | "og:description"): string {
  for (const meta of root.querySelectorAll("meta")) {
    const key = (meta.getAttribute("property") ?? meta.getAttribute("name") ?? "").toLowerCase();
    if (key === name) return meta.getAttribute("content")?.trim() ?? "";
  }
  return "";
}

function targetFullText(html: string, postId: string): string {
  const payload = serializedScriptPayload(html);
  if (!payload) return "";
  const encodedId = Buffer.from(`Tweet:${postId}`).toString("base64");
  const details = findObjectById(payload, `client:${encodedId}:details`);
  return details ? topLevelStringProperty(details, "full_text") : "";
}

function publicPostFromHtml(html: string, postId: string, usernameHint?: string): XPost | null {
  let root: ReturnType<typeof parse>;
  try {
    root = parse(html, { comment: false });
  } catch {
    return null;
  }
  const title = metaContent(root, "og:title");
  const titleUsername = title.match(/\(@([A-Za-z0-9_]{1,15})\)/)?.[1] ?? "";
  const text = (titleUsername ? metaContent(root, "og:description") : "") || targetFullText(html, postId);
  if (!text.trim()) return null;
  const username = titleUsername || usernameHint || "";
  return { id: postId, text: text.trim(), createdAt: "", username };
}

async function fetchPublicXHtml(url: URL, context: FetcherContext): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const fetched = await fetchGuardedResponse(
      url.toString(),
      {
        headers: { Accept: "text/html, application/xhtml+xml", "User-Agent": "akm-cli x fetcher" },
        signal: context.signal,
      },
      { timeoutMs: context.timeoutMs, retries: 1, allowPrivateHosts: context.allowPrivateHosts },
    );
    const { response } = fetched;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const html = await readBodyWithByteCap(response, X_PAGE_BYTE_CAP, {
      bodyTimeoutMs: X_BODY_TIMEOUT_MS,
      signal: context.signal,
    });
    return { html, finalUrl: fetched.finalUrl };
  } catch (error) {
    if (context.signal?.aborted) throw error;
    if (error instanceof ResponseTooLargeError) return null;
    return null;
  }
}

function postSnapshot(post: XPost): WikiSnapshotResult {
  const postId = validXId(post.id);
  if (!postId) throw new Error("X API returned an invalid post id");
  const username = post.username || "unknown";
  const canonicalUrl = post.username
    ? `https://x.com/${post.username}/status/${postId}`
    : `https://x.com/i/status/${postId}`;
  const markdown = [escapeXPlainText(post.text), post.createdAt ? `\n${post.createdAt}` : ""]
    .filter(Boolean)
    .join("\n");
  return {
    url: canonicalUrl,
    title: post.username ? `X post by @${post.username}` : `X post ${postId}`,
    markdown,
    preferredName: avoidReservedBasename(`x/${username}/status/${postId}`),
    tags: ["x", "twitter", "social", "post"],
  };
}

function articleSnapshot(
  article: PublicXArticle,
  resource: XContentResource,
  usernameHint?: string,
): WikiSnapshotResult {
  const id = resource.kind === "article" ? resource.articleId : resource.postId;
  const url =
    resource.kind === "article"
      ? `https://x.com/i/article/${resource.articleId}`
      : usernameHint
        ? `https://x.com/${usernameHint}/status/${resource.postId}`
        : `https://x.com/i/status/${resource.postId}`;
  const preferredName =
    resource.kind === "article"
      ? `x/article/${resource.articleId}`
      : usernameHint
        ? `x/${usernameHint}/status/${resource.postId}`
        : `x/status/${resource.postId}`;
  return {
    url,
    title: article.title || `X Article ${id}`,
    markdown: escapeXPlainText(article.body),
    preferredName: avoidReservedBasename(preferredName),
    tags: ["x", "twitter", "social", "article"],
  };
}

/** Build the RSS fallback URL from a template containing `{username}`. */
export function buildXRssUrl(template: string | undefined, username: string): URL | null {
  const raw = template?.trim();
  if (!raw) return null;
  if (!raw.includes("{username}")) {
    warn('[akm] x-profile: X_RSS_TEMPLATE must contain the "{username}" placeholder; ignoring it.');
    return null;
  }
  try {
    const url = new URL(raw.replaceAll("{username}", encodeURIComponent(username)));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchProfile(username: string, context: FetcherContext): Promise<WikiSnapshotResult | null> {
  const token = resolveXBearerToken(context);
  if (token) {
    try {
      const tweets = await fetchProfileViaApi(username, token, context);
      const markdown = tweets ? renderProfileMarkdown(username, tweets) : "";
      if (markdown) {
        return {
          url: `https://x.com/${username}`,
          title: `X — @${username}`,
          markdown,
          preferredName: avoidReservedBasename(`x/${username}`),
          tags: ["x", "twitter", "social"],
        };
      }
    } catch (error) {
      if (context.signal?.aborted) throw error;
    }
  }

  const rssUrl = buildXRssUrl(process.env.X_RSS_TEMPLATE, username);
  if (rssUrl) {
    const snapshot = await rssFetcher.fetch(rssUrl, context);
    if (snapshot) {
      return {
        ...snapshot,
        url: `https://x.com/${username}`,
        title: `X — @${username}`,
        preferredName: avoidReservedBasename(`x/${username}`),
        tags: ["x", "twitter", "social"],
      };
    }
  }

  warn(
    "[akm] x-profile: no content for @%s. Set X_BEARER_TOKEN, or store the token as the " +
      "secrets/x-bearer-token akm secret, or set X_RSS_TEMPLATE to an RSS bridge URL containing {username}.",
    username,
  );
  return null;
}

const xFetcher: WikiSnapshotFetcher = {
  name: "x",
  matches(url) {
    return extractXResource(url) !== null;
  },
  async fetch(url, context): Promise<WikiSnapshotResult | null> {
    const resource = extractXResource(url);
    if (!resource) return null;
    if (resource.kind === "profile") return fetchProfile(resource.username, context);

    const publicUrl =
      resource.kind === "status"
        ? new URL(
            resource.usernameHint
              ? `https://x.com/${resource.usernameHint}/status/${resource.postId}`
              : `https://x.com/i/status/${resource.postId}`,
          )
        : url;
    const publicPage = await fetchPublicXHtml(publicUrl, context);
    let html: string | null = null;
    let resolvedResource: XContentResource = resource;
    if (publicPage) {
      const finalResource = extractXResource(new URL(publicPage.finalUrl));
      if (
        (resource.kind === "status" && finalResource?.kind === "status" && finalResource.postId === resource.postId) ||
        (resource.kind === "article" &&
          finalResource?.kind === "article" &&
          finalResource.articleId === resource.articleId)
      ) {
        resolvedResource = finalResource;
        html = publicPage.html;
      }
    }
    if (html) {
      const article = extractPublicXArticle(
        html,
        resource.kind === "status" ? { postId: resource.postId } : { articleId: resource.articleId },
      );
      if (article) {
        return articleSnapshot(
          article,
          resolvedResource,
          resolvedResource.kind === "status" ? resolvedResource.usernameHint : undefined,
        );
      }
    }

    if (resource.kind === "article") return null;

    const token = resolveXBearerToken(context);
    if (token) {
      try {
        const post = await fetchPostViaApi(
          resource.postId,
          resolvedResource.kind === "status" ? resolvedResource.usernameHint : resource.usernameHint,
          token,
          context,
        );
        if (post) return postSnapshot(post);
      } catch (error) {
        if (context.signal?.aborted) throw error;
      }
    }

    const publicPost = html
      ? publicPostFromHtml(
          html,
          resource.postId,
          resolvedResource.kind === "status" ? resolvedResource.usernameHint : resource.usernameHint,
        )
      : null;
    return publicPost ? postSnapshot(publicPost) : null;
  },
};

export default xFetcher;
