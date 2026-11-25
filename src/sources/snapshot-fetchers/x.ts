// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parse } from "node-html-parser";
import { readBodyWithByteCap } from "../../core/common";
import { warn } from "../../core/warn";
import { avoidReservedBasename, coerceString, escapeMarkdownStructure } from "./fetcher-util";
import { fetchGuardedResponse, fetchPinnedJson } from "./host-guard";
import rssFetcher from "./rss";
import type { FetcherContext, WikiSnapshotFetcher, WikiSnapshotResult } from "./types";
import { extractPublicXArticle, type PublicXArticle, targetFullText } from "./x-article";

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
  if (!data || coerceString(data.id) !== postId) return null;
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
    const iso = toIsoDate(tweet.createdAt);
    sections.push(`## ${iso || "(undated)"}`, "", escapeXPlainText(tweet.text), "");
    if (tweet.id) sections.push(`https://x.com/${username}/status/${tweet.id}`, "");
  }
  return sections.join("\n").trimEnd();
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
