// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `credentials.json`: the keys akm holds for a connection and for the two
 * services with an endpoint of their own, each stored for one endpoint, and how
 * a block's `apiKey` resolves to one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  collectCredentialValues,
  fileFlatCredentials,
  readCredential,
  resolveApiKey,
  writeCredential,
} from "../src/core/config/credentials";
import { getConfigDir } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";

const storePath = () => path.join(getConfigDir(), "credentials.json");
const readStoreFile = () => JSON.parse(fs.readFileSync(storePath(), "utf8")) as Record<string, unknown>;
const writeStoreFile = (value: unknown) => {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), typeof value === "string" ? value : JSON.stringify(value));
};
const mode = (target: string) => fs.statSync(target).mode & 0o777;

const LAB = "https://lab.example.test/v1";
const lab = { connection: "lab" } as const;
const embedding = { service: "embedding" } as const;

let warnings: string[] = [];

beforeEach(() => {
  fs.rmSync(storePath(), { force: true });
  warnings = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  fs.rmSync(storePath(), { force: true });
});

describe("the store", () => {
  test("an absent file holds nothing, and reading it is silent", () => {
    expect(readCredential(lab, LAB)).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(fs.existsSync(storePath())).toBe(false);
  });

  test("writing creates the file 0600, and a key reads back for its slot and endpoint", () => {
    writeCredential(lab, "key-lab", LAB);
    expect(readCredential(lab, LAB)).toBe("key-lab");
    expect(readCredential({ connection: "other" }, LAB)).toBeUndefined();
    expect(readStoreFile()).toEqual({ connections: { lab: { key: "key-lab", endpoint: LAB } } });
    expect(mode(storePath())).toBe(0o600);
  });

  test("a second write keeps the other keys and replaces the same slot", () => {
    writeCredential(lab, "one", LAB);
    writeCredential(embedding, "two", "https://embed.example.test/v1");
    writeCredential(lab, "three", LAB);
    expect(readStoreFile()).toEqual({
      connections: { lab: { key: "three", endpoint: LAB } },
      services: { embedding: { key: "two", endpoint: "https://embed.example.test/v1" } },
    });
    expect(mode(storePath())).toBe(0o600);
  });

  test("an empty stored key reads as no key", () => {
    writeStoreFile({ connections: { lab: { key: "", endpoint: LAB } } });
    expect(readCredential(lab, LAB)).toBeUndefined();
  });

  test("a store that is not a JSON object reads as empty with one warning, and is never overwritten", () => {
    for (const corrupt of ["{not json", "[]", '"text"']) {
      _resetWarnOnceForTests();
      warnings = [];
      writeStoreFile(corrupt);
      expect(readCredential(lab, LAB)).toBeUndefined();
      expect(readCredential(lab, LAB)).toBeUndefined();
      expect(warnings.filter((w) => w.includes("is not a JSON object"))).toHaveLength(1);
      expect(() => writeCredential(lab, "new", LAB)).toThrow(/is not a JSON object; refusing to overwrite/);
      expect(fs.readFileSync(storePath(), "utf8")).toBe(corrupt);
    }
  });

  test("a store that cannot be read says so, in its own words, and is never overwritten", () => {
    // A directory where the file belongs reads as an error that is not "absent".
    fs.mkdirSync(storePath(), { recursive: true });
    try {
      expect(readCredential(lab, LAB)).toBeUndefined();
      expect(readCredential(lab, LAB)).toBeUndefined();
      const unreadable = warnings.filter((w) => w.includes("cannot be read"));
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]).toContain("EISDIR");
      expect(unreadable[0]).not.toContain("not a JSON object");
      expect(() => writeCredential(lab, "new", LAB)).toThrow(/cannot be read \(EISDIR\); refusing to overwrite/);
    } finally {
      fs.rmSync(storePath(), { recursive: true, force: true });
    }
  });

  test("an entry that is not { key, endpoint } is named once and ignored, and a write keeps it as it is", () => {
    writeStoreFile({ connections: { lab: { token: "x" }, other: { key: "k", endpoint: LAB } }, extra: 3 });
    expect(readCredential(lab, LAB)).toBeUndefined();
    expect(readCredential(lab, LAB)).toBeUndefined();
    expect(readCredential({ connection: "other" }, LAB)).toBe("k");
    expect(warnings.filter((w) => w.includes('the entry for connection "lab" is not'))).toHaveLength(1);
    expect(warnings.join("\n")).not.toContain("token");

    writeCredential(embedding, "key-embedding", LAB);
    expect(readStoreFile()).toEqual({
      connections: { lab: { token: "x" }, other: { key: "k", endpoint: LAB } },
      services: { embedding: { key: "key-embedding", endpoint: LAB } },
      extra: 3,
    });
  });
});

describe("a key is stored for one endpoint", () => {
  test("it is read for that endpoint however it is spelled, and for no other", () => {
    writeCredential(lab, "key-lab", LAB);
    expect(readCredential(lab, `${LAB}/`)).toBe("key-lab");
    expect(readCredential(lab, `${LAB}/chat/completions`)).toBe("key-lab");
    expect(warnings).toEqual([]);
    expect(readCredential(lab, "https://other.example.test/v1")).toBeUndefined();
  });

  test("a block whose endpoint changed gets no key, and the warning names both endpoints without their credentials", () => {
    writeCredential(lab, "key-lab", "https://user:pw@old.example.test/v1?token=abc");
    expect(readCredential(lab, "https://user:pw@new.example.test/v1")).toBeUndefined();
    expect(readCredential(lab, "https://user:pw@new.example.test/v1")).toBeUndefined();
    const named = warnings.filter((w) => w.includes("belongs to"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("old.example.test");
    expect(named[0]).toContain("new.example.test");
    for (const secret of ["key-lab", "pw", "abc"]) expect(named[0]).not.toContain(secret);
  });

  test("a stored key is not moved to the new endpoint by a setup that gives none: the old entry stays for the old one", () => {
    writeCredential(lab, "key-lab", LAB);
    expect(readCredential(lab, "https://new.example.test/v1")).toBeUndefined();
    expect(readCredential(lab, LAB)).toBe("key-lab");
  });
});

describe("connections and services are different namespaces", () => {
  test("a connection called embedding and the embedding service hold different keys", () => {
    writeCredential({ connection: "embedding" }, "chat-key", "https://chat.example.test/v1");
    writeCredential(embedding, "service-key", "https://embed.example.test/v1");
    expect(readCredential({ connection: "embedding" }, "https://chat.example.test/v1")).toBe("chat-key");
    expect(readCredential(embedding, "https://embed.example.test/v1")).toBe("service-key");
    // Neither is read for the other's slot, even at the other's endpoint.
    expect(readCredential({ connection: "embedding" }, "https://embed.example.test/v1")).toBeUndefined();
    expect(readCredential(embedding, "https://chat.example.test/v1")).toBeUndefined();
  });

  test("writing one leaves the other as it was", () => {
    writeCredential(embedding, "service-key", "https://embed.example.test/v1");
    writeCredential({ connection: "embedding" }, "chat-key", "https://chat.example.test/v1");
    expect(readStoreFile()).toEqual({
      connections: { embedding: { key: "chat-key", endpoint: "https://chat.example.test/v1" } },
      services: { embedding: { key: "service-key", endpoint: "https://embed.example.test/v1" } },
    });
  });
});

describe("a key in the older flat form", () => {
  test("is named once and not used, for any endpoint", () => {
    writeStoreFile({ lab: "flat-key" });
    expect(readCredential(lab, LAB)).toBeUndefined();
    expect(readCredential(lab, LAB)).toBeUndefined();
    expect(warnings.filter((w) => w.includes('the key "lab" is in the older form'))).toHaveLength(1);
  });

  test("is filed under the endpoint of the block it belongs to, then read for that endpoint", () => {
    writeStoreFile({ lab: "flat-key", curateRerank: "rerank-key", ghost: "no-block" });
    const endpoints: Record<string, string> = {
      lab: LAB,
      curateRerank: "https://rerank.example.test/v1",
    };
    const endpointOf = (slot: Parameters<typeof readCredential>[0]) =>
      endpoints["connection" in slot ? slot.connection : slot.service];

    const dryRun = fileFlatCredentials(endpointOf, false);
    expect(dryRun.filed).toEqual(["lab", "curateRerank"]);
    expect(readStoreFile()).toEqual({ lab: "flat-key", curateRerank: "rerank-key", ghost: "no-block" });

    fileFlatCredentials(endpointOf, true);
    expect(readStoreFile()).toEqual({
      ghost: "no-block",
      connections: { lab: { key: "flat-key", endpoint: LAB } },
      services: { curateRerank: { key: "rerank-key", endpoint: "https://rerank.example.test/v1" } },
    });
    expect(readCredential(lab, LAB)).toBe("flat-key");
  });

  test("whose name could be a connection or the embedding service is not guessed", () => {
    writeStoreFile({ embedding: "flat-key" });
    const result = fileFlatCredentials(() => "https://both.example.test/v1", true);
    expect(result.filed).toEqual([]);
    expect(result.notes.join("\n")).toContain("could belong to the embedding service or to the connection");
    expect(readStoreFile()).toEqual({ embedding: "flat-key" });
  });
});

describe("resolveApiKey", () => {
  test("a $VAR reference reads that variable and never the store", () => {
    writeCredential(lab, "stored", LAB);
    expect(resolveApiKey("$LAB_KEY", lab, LAB, { LAB_KEY: " from-env " })).toBe("from-env");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference syntax under test
    expect(resolveApiKey("${LAB_KEY}", lab, LAB, { LAB_KEY: "from-env" })).toBe("from-env");
  });

  test("an unset or empty variable sends no key, naming the variable once and never the store's key", () => {
    writeCredential(lab, "stored", LAB);
    expect(resolveApiKey("$LAB_KEY", lab, LAB, {})).toBeUndefined();
    expect(resolveApiKey("$LAB_KEY", lab, LAB, { LAB_KEY: "  " })).toBeUndefined();
    expect(warnings.filter((w) => w.includes("LAB_KEY"))).toHaveLength(1);
  });

  test("quiet resolution does not warn", () => {
    expect(resolveApiKey("$LAB_KEY", lab, LAB, {}, true)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("no apiKey in config reads the key stored for the block's slot and endpoint", () => {
    writeCredential(lab, "stored", LAB);
    expect(resolveApiKey(undefined, lab, LAB, {})).toBe("stored");
    expect(resolveApiKey(undefined, { connection: "other" }, LAB, {})).toBeUndefined();
    expect(resolveApiKey(undefined, lab, "https://elsewhere.example.test/v1", {})).toBeUndefined();
  });

  test("a value that is not a $VAR reference is not a key: the store is read instead", () => {
    writeCredential(lab, "stored", LAB);
    expect(resolveApiKey("sk-literal", lab, LAB, {})).toBe("stored");
  });
});

describe("collectCredentialValues", () => {
  test("lists every key akm could send, from a variable or the store, whatever endpoint the store holds it for", () => {
    writeCredential({ connection: "stored-conn" }, "stored-key", "http://b/v1");
    writeCredential(embedding, "embed-key", "http://e/v1");
    writeCredential({ connection: "retired" }, "retired-key", "http://old/v1");
    const values = collectCredentialValues(
      {
        connections: {
          envConn: { endpoint: "http://a/v1", apiKey: "$A_KEY" },
          "stored-conn": { endpoint: "http://b/v1" },
          unkeyed: { endpoint: "http://c/v1", apiKey: "$UNSET_KEY" },
        },
        search: { curateRerank: { endpoint: "http://d/v1", model: "m", apiKey: "$RERANK_KEY" } },
      } as unknown as Parameters<typeof collectCredentialValues>[0],
      { A_KEY: "env-key", RERANK_KEY: "rerank-key" },
    );
    expect(values.sort()).toEqual(["embed-key", "env-key", "rerank-key", "retired-key", "stored-key"]);
    expect(warnings).toEqual([]);
  });

  test("an empty config has no values", () => {
    expect(collectCredentialValues({}, {})).toEqual([]);
  });
});
