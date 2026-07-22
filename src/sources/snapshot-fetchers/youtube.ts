// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fetchWithRetry } from "../../core/common";
import type { WikiSnapshotFetcher, WikiSnapshotResult } from "./types";

type YoutubeCaptionTrack = {
  baseUrl?: unknown;
  languageCode?: unknown;
  kind?: unknown;
};

type YoutubePlayerResponse = {
  videoDetails?: {
    title?: unknown;
    shortDescription?: unknown;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YoutubeCaptionTrack[];
    };
  };
};

const YOUTUBE_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"]);
const WATCH_HOST = "https://www.youtube.com/watch?v=";

// Captions: the WEB watch-page caption baseUrls are now Proof-of-Origin-Token
// gated (they carry `exp=xpe` and return an empty body without a `pot` token).
// The ANDROID InnerTube `player` client still returns UNGATED caption baseUrls
// that serve the transcript, so captions are sourced from there. See
// https://github.com/yt-dlp/yt-dlp/issues/13075.
const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
// Long-stable public InnerTube key; only authorizes the player call (not auth).
const DEFAULT_INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const ANDROID_INNERTUBE_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  androidSdkVersion: 34,
  hl: "en",
  gl: "US",
} as const;

function extractVideoId(url: URL): string | null {
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
  if (url.hostname === "youtu.be") {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0]?.trim();
    return id || null;
  }
  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v")?.trim();
    return id || null;
  }
  if (url.pathname.startsWith("/shorts/")) {
    const id = url.pathname.slice("/shorts/".length).split("/")[0]?.trim();
    return id || null;
  }
  if (url.pathname.startsWith("/embed/")) {
    const id = url.pathname.slice("/embed/".length).split("/")[0]?.trim();
    return id || null;
  }
  return null;
}

function canonicalWatchUrl(videoId: string): string {
  return `${WATCH_HOST}${encodeURIComponent(videoId)}`;
}

function decodeEntities(value: string): string {
  const safeFromCodePoint = (codePoint: number, fallback: string) => {
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return fallback;
    }
  };

  return value
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => safeFromCodePoint(Number.parseInt(hex, 16), m))
    .replace(/&#([0-9]+);/g, (m, dec) => safeFromCodePoint(Number.parseInt(dec, 10), m))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function extractJsonObjectAfter(marker: string, source: string): string | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function parsePlayerResponse(html: string): YoutubePlayerResponse | null {
  const jsonText = extractJsonObjectAfter("ytInitialPlayerResponse =", html);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as YoutubePlayerResponse;
  } catch {
    return null;
  }
}

function chooseCaptionTrack(tracks: YoutubeCaptionTrack[]): string | null {
  const normalized = tracks
    .map((track) => ({
      baseUrl: typeof track.baseUrl === "string" ? track.baseUrl : "",
      languageCode: typeof track.languageCode === "string" ? track.languageCode : "",
      kind: typeof track.kind === "string" ? track.kind : "",
    }))
    .filter((track) => track.baseUrl);
  if (normalized.length === 0) return null;

  const preferred =
    normalized.find((track) => track.languageCode === "en" && track.kind !== "asr") ??
    normalized.find((track) => track.languageCode.startsWith("en") && track.kind !== "asr") ??
    normalized.find((track) => track.languageCode.startsWith("en")) ??
    normalized[0]!;
  return preferred.baseUrl;
}

async function fetchText(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: "text/html,application/json,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "akm-cli youtube fetcher",
      },
      signal,
    },
    { timeout: timeoutMs, retries: 1 },
  );
  if (!response.ok) return null;
  return response.text();
}

function parseTranscript(xml: string): string | null {
  // Two timedtext shapes: legacy srv1 `<text>` cues, and the format-3
  // `<timedtext format="3">` `<p>` cues that the ANDROID InnerTube caption
  // URLs return. Strip any nested `<s>` word tags via stripTags.
  const matches = [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g), ...xml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)];
  const texts = matches.map((match) => decodeEntities(stripTags(match[1] ?? "")).trim()).filter(Boolean);
  if (texts.length === 0) return null;
  return texts.join("\n");
}

/**
 * Fetch caption tracks via the ANDROID InnerTube `player` endpoint, whose
 * caption baseUrls are not POT-gated. Returns [] on any failure so the caller
 * can fall back to the (usually empty) watch-page tracks and degrade to a
 * description-only snapshot.
 */
async function fetchInnertubeCaptionTracks(
  videoId: string,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<YoutubeCaptionTrack[]> {
  try {
    const response = await fetchWithRetry(
      `${INNERTUBE_PLAYER_URL}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
        },
        body: JSON.stringify({ context: { client: ANDROID_INNERTUBE_CLIENT }, videoId }),
        signal,
      },
      { timeout: timeoutMs, retries: 1 },
    );
    if (!response.ok) return [];
    const json = (await response.json()) as YoutubePlayerResponse;
    return json.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  } catch {
    return [];
  }
}

/** Extract the page's InnerTube API key, falling back to the stable default. */
function extractInnertubeKey(html: string): string {
  return html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? DEFAULT_INNERTUBE_KEY;
}

const youtubeFetcher: WikiSnapshotFetcher = {
  name: "youtube-transcript",
  matches(url) {
    return extractVideoId(url) !== null;
  },
  async fetch(url, context): Promise<WikiSnapshotResult | null> {
    const videoId = extractVideoId(url);
    if (!videoId) return null;

    const watchUrl = canonicalWatchUrl(videoId);
    const watchHtml = await fetchText(watchUrl, context.timeoutMs, context.signal);
    if (!watchHtml) return null;

    const playerResponse = parsePlayerResponse(watchHtml);
    if (!playerResponse) return null;

    const title =
      typeof playerResponse.videoDetails?.title === "string" ? playerResponse.videoDetails.title.trim() : "";
    const description =
      typeof playerResponse.videoDetails?.shortDescription === "string"
        ? playerResponse.videoDetails.shortDescription.trim()
        : "";
    const sections: string[] = [];
    let hasTranscript = false;
    if (description) {
      sections.push("## Description", "", description);
    }

    // Prefer ungated ANDROID InnerTube caption tracks; fall back to the
    // (now usually empty) watch-page tracks so a description-only snapshot
    // still works when InnerTube is unavailable.
    const apiKey = extractInnertubeKey(watchHtml);
    let tracks = await fetchInnertubeCaptionTracks(videoId, apiKey, context.timeoutMs, context.signal);
    if (tracks.length === 0) {
      tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    }
    const captionUrl = chooseCaptionTrack(tracks);
    if (captionUrl) {
      const transcriptXml = await fetchText(captionUrl, context.timeoutMs, context.signal);
      const transcript = transcriptXml ? parseTranscript(transcriptXml) : null;
      if (transcript) {
        hasTranscript = true;
        sections.push("## Transcript", "", transcript);
      }
    }

    if (sections.length === 0) return null;

    return {
      url: watchUrl,
      title: title || `YouTube ${videoId}`,
      markdown: sections.join("\n"),
      preferredName: `youtube/${videoId}`,
      tags: hasTranscript ? ["youtube", "video", "transcript"] : ["youtube", "video"],
    };
  },
};

export default youtubeFetcher;
