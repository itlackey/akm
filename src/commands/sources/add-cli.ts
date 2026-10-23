// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { defineJsonCommand, output } from "../../cli/shared";
import { VALID_ADAPTER_IDS } from "../../core/adapter/adapter-ids";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { warn } from "../../core/warn";
import { akmUpdate } from "./installed-stashes";
import { akmAdd } from "./source-add";
import { addStash, removeStash } from "./source-manage";

// ── Shared website-options helper ──────────

export function buildWebsiteOptions(args: Record<string, unknown>): { maxPages?: number; maxDepth?: number } {
  // getStringArg maps absent/blank to undefined; parsePositiveIntFlag maps
  // undefined to undefined — so an unsupplied flag simply omits the key.
  const maxPages = parsePositiveIntFlag(getStringArg(args, "max-pages"), "--max-pages");
  const maxDepth = parsePositiveIntFlag(getStringArg(args, "max-depth"), "--max-depth");
  return { ...(maxPages !== undefined ? { maxPages } : {}), ...(maxDepth !== undefined ? { maxDepth } : {}) };
}

// ── HTTP safety check ─────────────────────────────────────────────────────────

export function shouldWarnOnPlainHttp(ref: string): boolean {
  if (!ref.startsWith("http://")) return false;
  try {
    const hostname = new URL(ref).hostname.toLowerCase();
    return (
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "0.0.0.0" &&
      hostname !== "::1" &&
      hostname !== "[::1]" &&
      !hostname.endsWith(".localhost")
    );
  } catch {
    return true;
  }
}

// ── Command definition ────────────────────────────────────────────────────────

export const addCommand = defineJsonCommand({
  meta: {
    name: "add",
    description: "Add a source (local directory, website, npm package, GitHub repo, git URL, or remote provider)",
  },
  args: {
    ref: {
      type: "positional",
      description: "Path, URL, or registry ref (website URL, npm package, owner/repo, git URL, or local directory)",
      required: true,
    },
    provider: { type: "string", description: "Provider type (e.g. website, npm). Required for URL sources." },
    options: { type: "string", description: 'Provider options as JSON (e.g. \'{"apiKey":"key"}\').' },
    name: { type: "string", description: "Human-friendly name for the source" },
    adapter: {
      type: "string",
      description:
        "Override the auto-detected component adapter for a local directory (#909). One of: " +
        `${VALID_ADAPTER_IDS.join(", ")}.`,
    },
    writable: {
      type: "boolean",
      description: "Mark a git bundle as writable so changes can be pushed back",
      default: false,
    },
    before: { type: "string", description: "Insert the new bundle before this configured bundle" },
    after: { type: "string", description: "Insert the new bundle after this configured bundle" },
    credential: {
      type: "string",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${ref}` token syntax documented for users, not interpolation
      description: "Git HTTPS bearer credential reference ($VAR or ${secrets/name}); never a literal token",
    },
    "max-pages": { type: "string", description: "Maximum pages to crawl for website sources (default: 50)" },
    "max-depth": { type: "string", description: "Maximum crawl depth for website sources (default: 3)" },
    "allow-insecure-transport": {
      type: "boolean",
      description: "Allow a plain HTTP source URL after explicitly accepting transport substitution risk.",
      default: false,
    },
    // Deprecated no-op, accepted through 0.10 so scripts that pass it do not
    // fail with UNKNOWN_FLAG. Installing a bundle is the trust decision: its
    // env files are no longer scanned for process-hijacking keys.
    "allow-dangerous-env-keys": {
      type: "boolean",
      description:
        "Deprecated, no effect: add no longer scans env files for process-hijacking keys. Accepted through 0.10 for existing scripts.",
      default: false,
    },
  },
  async run({ args }) {
    const ref = args.ref.trim();
    const allowInsecureTransport = args["allow-insecure-transport"];
    if (args.before && args.after) throw new UsageError("Only one of --before or --after may be used.");

    // --provider → declarative bundle source (URL for git/website; bare
    // package spec for npm — R-013). Git is materialized below before success;
    // other providers remain declarative until bundle update.
    if (args.provider) {
      if (shouldWarnOnPlainHttp(ref)) {
        if (!allowInsecureTransport) {
          throw new UsageError(
            "Source URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious payload. " +
              "Use https:// or pass --allow-insecure-transport if you have explicitly accepted the risk.",
            "INVALID_FLAG_VALUE",
            "Re-run with `--allow-insecure-transport` only after confirming the URL is trusted.",
          );
        }
        warn(
          "Warning: source URL uses plain HTTP (not HTTPS). --allow-insecure-transport was set; an on-path attacker could substitute a malicious payload.",
        );
      }
      let parsedOptions: Record<string, unknown> | undefined;
      if (args.options) {
        try {
          const parsed = JSON.parse(args.options);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new UsageError("--options must be a JSON object");
          }
          parsedOptions = parsed;
        } catch (err) {
          if (err instanceof UsageError) throw err;
          throw new UsageError("--options must be valid JSON");
        }
      }
      const result = addStash({
        target: ref,
        name: args.name,
        providerType: args.provider,
        options: parsedOptions,
        writable: args.writable,
        before: args.before,
        after: args.after,
        credential: args.credential,
      });
      // Declarative git sources must be materialized and indexed before add
      // reports success. This also makes --provider git behave consistently
      // with inferred/registry git installs (#968/#970).
      if (args.provider === "git" && result.added && result.entry?.name) {
        let updated: Awaited<ReturnType<typeof akmUpdate>>;
        try {
          updated = await akmUpdate({ target: result.entry.name });
        } catch (error) {
          removeStash(result.entry.name);
          throw error;
        }
        appendEvent({
          eventType: "add",
          metadata: {
            target: ref,
            provider: args.provider,
            name: args.name ?? null,
            writable: args.writable === true,
          },
        });
        output("add", { ...result, index: updated.index });
        return;
      }
      appendEvent({
        eventType: "add",
        metadata: { target: ref, provider: args.provider, name: args.name ?? null, writable: args.writable === true },
      });
      output("add", result);
      return;
    }

    if (shouldWarnOnPlainHttp(ref)) {
      if (!allowInsecureTransport) {
        throw new UsageError(
          "Source URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious payload. " +
            "Use https:// or pass --allow-insecure-transport if you have explicitly accepted the risk.",
          "INVALID_FLAG_VALUE",
          "Re-run with `--allow-insecure-transport` only after confirming the URL is trusted.",
        );
      }
      warn(
        "Warning: source URL uses plain HTTP (not HTTPS). --allow-insecure-transport was set; an on-path attacker could substitute a malicious payload.",
      );
    }
    const websiteOptions = buildWebsiteOptions(args);

    const result = await akmAdd({
      ref,
      name: args.name,
      options: Object.keys(websiteOptions).length > 0 ? websiteOptions : undefined,
      writable: args.writable,
      adapter: args.adapter,
      before: args.before,
      after: args.after,
      credential: args.credential,
    });
    appendEvent({
      eventType: "add",
      metadata: {
        target: ref,
        name: args.name ?? null,
        writable: args.writable === true,
      },
    });

    output("add", result);
  },
});
