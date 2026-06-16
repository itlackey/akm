import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SearchResponse } from "../src/sources/types";

type AkmSearchInput = {
  query: string;
  type?: string;
  limit?: number;
  source?: string;
  skipLogging?: boolean;
};

const calls: AkmSearchInput[] = [];
let searchImpl: (input: AkmSearchInput) => Promise<SearchResponse>;

function emptyResponse(): SearchResponse {
  return {
    schemaVersion: 1,
    stashDir: "/tmp/stash",
    source: "stash",
    hits: [],
  };
}

mock.module("../src/commands/read/search", () => ({
  akmSearch: async (input: AkmSearchInput) => {
    calls.push(input);
    return searchImpl(input);
  },
  parseSearchSource: (value: string) => value,
}));

const { searchForCuration } = await import("../src/commands/read/curate");

beforeEach(() => {
  calls.length = 0;
  searchImpl = async () => emptyResponse();
});

describe("searchForCuration", () => {
  test("falls back when the initial phrase hit is weak", async () => {
    searchImpl = async (input) => {
      if (input.query === "docker cleanup audit") {
        return {
          ...emptyResponse(),
          hits: [
            {
              type: "command",
              name: "release-manager",
              ref: "command:release-manager",
              path: "/tmp/release",
              score: 0.05,
            },
          ],
        };
      }
      if (input.query === "docker") {
        return {
          ...emptyResponse(),
          hits: [
            {
              type: "script",
              name: "docker-clean",
              ref: "script:docker-clean",
              path: "/tmp/docker-clean",
              score: 0.9,
            },
          ],
        };
      }
      return emptyResponse();
    };

    const result = await searchForCuration({
      query: "docker cleanup audit",
      limit: 12,
      source: "stash",
    });

    expect(calls.map((call) => call.query)).toEqual(["docker cleanup audit", "docker", "cleanup", "audit"]);
    expect(result.hits.map((hit) => ("ref" in hit ? hit.ref : `registry:${hit.id}`))).toEqual([
      "script:docker-clean",
      "command:release-manager",
    ]);
  });

  test("does not fall back when the initial phrase search is already strong", async () => {
    searchImpl = async (input) => {
      if (input.query === "docker homelab") {
        return {
          ...emptyResponse(),
          hits: [
            {
              type: "skill",
              name: "docker-homelab",
              ref: "skill:docker-homelab",
              path: "/tmp/skill",
              score: 0.95,
            },
            {
              type: "knowledge",
              name: "docker-compose-reference",
              ref: "knowledge:docker-compose-reference",
              path: "/tmp/knowledge",
              score: 0.85,
            },
          ],
        };
      }
      return emptyResponse();
    };

    const result = await searchForCuration({
      query: "docker homelab",
      limit: 12,
      source: "stash",
    });

    expect(calls.map((call) => call.query)).toEqual(["docker homelab"]);
    expect(result.hits.map((hit) => ("ref" in hit ? hit.ref : `registry:${hit.id}`))).toEqual([
      "skill:docker-homelab",
      "knowledge:docker-compose-reference",
    ]);
  });

  test("allows one-token prompt-residue fallback", async () => {
    searchImpl = async (input) => {
      if (input.query === "docker") {
        return {
          ...emptyResponse(),
          hits: [
            {
              type: "script",
              name: "docker-clean",
              ref: "script:docker-clean",
              path: "/tmp/docker-clean",
              score: 0.9,
            },
          ],
        };
      }
      return emptyResponse();
    };

    const result = await searchForCuration({ query: "the docker", limit: 12, source: "stash" });

    expect(calls.map((call) => call.query)).toEqual(["the docker", "docker"]);
    expect(result.hits.map((hit) => ("ref" in hit ? hit.ref : `registry:${hit.id}`))).toEqual(["script:docker-clean"]);
  });
});
