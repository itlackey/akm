// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `credentials.json`: the keys akm holds for a connection, `embedding` and
 * `curateRerank`, and how a block's `apiKey` resolves to one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  collectCredentialValues,
  deleteCredential,
  readCredential,
  resolveApiKey,
  writeCredential,
} from "../src/core/config/credentials";
import { getConfigDir } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";

const storePath = () => path.join(getConfigDir(), "credentials.json");
const readStoreFile = () => JSON.parse(fs.readFileSync(storePath(), "utf8")) as Record<string, string>;
const mode = (target: string) => fs.statSync(target).mode & 0o777;

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
    expect(readCredential("lab")).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(fs.existsSync(storePath())).toBe(false);
  });

  test("writing creates the file 0600, and a key reads back under its name", () => {
    writeCredential("lab", "key-lab");
    expect(readCredential("lab")).toBe("key-lab");
    expect(readCredential("other")).toBeUndefined();
    expect(mode(storePath())).toBe(0o600);
  });

  test("a second write keeps the other keys and replaces the same name", () => {
    writeCredential("lab", "one");
    writeCredential("embedding", "two");
    writeCredential("lab", "three");
    expect(readStoreFile()).toEqual({ lab: "three", embedding: "two" });
    expect(mode(storePath())).toBe(0o600);
  });

  test("deleting removes one key and keeps the rest; deleting a name that is not there is harmless", () => {
    writeCredential("lab", "one");
    writeCredential("embedding", "two");
    deleteCredential("lab");
    expect(readStoreFile()).toEqual({ embedding: "two" });
    deleteCredential("missing");
    expect(readStoreFile()).toEqual({ embedding: "two" });
  });

  test("an empty stored value reads as no key", () => {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify({ lab: "" }));
    expect(readCredential("lab")).toBeUndefined();
  });

  test("a store that is not a JSON object reads as empty with one warning, and is never overwritten", () => {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    for (const corrupt of ["{not json", "[]", '"text"']) {
      _resetWarnOnceForTests();
      warnings = [];
      fs.writeFileSync(storePath(), corrupt);
      expect(readCredential("lab")).toBeUndefined();
      expect(readCredential("lab")).toBeUndefined();
      expect(warnings.filter((w) => w.includes("credentials.json"))).toHaveLength(1);
      expect(() => writeCredential("lab", "new")).toThrow(/refusing to overwrite/);
      expect(() => deleteCredential("lab")).toThrow(/refusing to overwrite/);
      expect(fs.readFileSync(storePath(), "utf8")).toBe(corrupt);
    }
  });
});

describe("resolveApiKey", () => {
  test("a $VAR reference reads that variable and never the store", () => {
    writeCredential("lab", "stored");
    expect(resolveApiKey("$LAB_KEY", "lab", { LAB_KEY: " from-env " })).toBe("from-env");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference syntax under test
    expect(resolveApiKey("${LAB_KEY}", "lab", { LAB_KEY: "from-env" })).toBe("from-env");
  });

  test("an unset or empty variable sends no key, naming the variable once and never the store's key", () => {
    writeCredential("lab", "stored");
    expect(resolveApiKey("$LAB_KEY", "lab", {})).toBeUndefined();
    expect(resolveApiKey("$LAB_KEY", "lab", { LAB_KEY: "  " })).toBeUndefined();
    expect(warnings.filter((w) => w.includes("LAB_KEY"))).toHaveLength(1);
  });

  test("quiet resolution does not warn", () => {
    expect(resolveApiKey("$LAB_KEY", "lab", {}, true)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("no apiKey in config reads the key stored under the block's name", () => {
    writeCredential("lab", "stored");
    expect(resolveApiKey(undefined, "lab", {})).toBe("stored");
    expect(resolveApiKey(undefined, "other", {})).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("a value that is not a $VAR reference is not a key: the store is read instead", () => {
    writeCredential("lab", "stored");
    expect(resolveApiKey("sk-literal", "lab", {})).toBe("stored");
  });
});

describe("collectCredentialValues", () => {
  test("lists every key the config resolves now, from a variable or the store, for redaction", () => {
    writeCredential("stored-conn", "stored-key");
    writeCredential("embedding", "embed-key");
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
    expect(values.sort()).toEqual(["embed-key", "env-key", "rerank-key", "stored-key"]);
    expect(warnings).toEqual([]);
  });

  test("an empty config has no values", () => {
    expect(collectCredentialValues({}, {})).toEqual([]);
  });
});
