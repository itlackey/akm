import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigValue, listConfig } from "../src/commands/config-cli";
import { collectEgressAdvisory } from "../src/commands/health/egress";
import { resolveRegistries, searchRegistry } from "../src/commands/read/registry-search";
import { DEFAULT_CONFIG, loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import {
  formatRegistryError,
  formatRegistryUrl,
  hasRegistryUrlCredentials,
  redactCredentialBearingUrls,
} from "../src/core/registry-url";
import { clearLogFile, setLogFile, warn } from "../src/core/warn";
import { formatInfoPlain, formatRegistryListPlain, formatRegistryRemovePlain } from "../src/output/text/command-format";
import { resolveRegistryProviderFactory } from "../src/registry/factory";
import { loadSetupStashes } from "../src/setup/registry-stash-loader";
import { runCliCapture } from "./_helpers/cli";
import {
  type IsolatedAkmStorage,
  withEnvSync,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "./_helpers/sandbox";

const USERNAME = "registry-alice";
const PASSWORD = "registry-swordfish";
const CREDENTIAL_URL = `https://${USERNAME}:${PASSWORD}@registry.example.test/index.json`;
const EXACT_SCHEME_CONTROL_URL = "https:\t//audit-user:audit-pass@host.test/index.json";
const EXACT_NESTED_SCHEME_CONTROL_URL = "https://safe.test/?next=h\tttps://nested-user:nested-pass@evil.test/x";
const CONTROL_CHARACTERS = ["\t", "\r", "\n"] as const;
const CANONICAL_SCHEMES = ["http://", "https://"] as const;
const CONTROL_SCHEME_CREDENTIAL_URLS = [
  EXACT_SCHEME_CONTROL_URL,
  ...CONTROL_CHARACTERS.flatMap((control) =>
    CANONICAL_SCHEMES.flatMap((canonicalScheme) =>
      Array.from({ length: canonicalScheme.length - 1 }, (_, offset) => {
        const insertion = offset + 1;
        const scheme = `${canonicalScheme.slice(0, insertion)}${control}${canonicalScheme.slice(insertion)}`;
        return `${scheme}${USERNAME}:${PASSWORD}@controls.example.test/index.json`;
      }),
    ),
  ),
] as const;
const NESTED_CONTROL_SCHEME_CREDENTIAL_URLS = [
  EXACT_NESTED_SCHEME_CONTROL_URL,
  ...CONTROL_SCHEME_CREDENTIAL_URLS.map((url) => `https://safe.test/?next=${url}`),
] as const;
const SOFT_DELIMITER_USERNAME_URLS = [" ", '"', "'", "`", "<", ">"].map(
  (delimiter) => `https://audit${delimiter}soft-user-secret@userinfo.example.test/index.json`,
);
const PASSWORD_DELIMITER_URLS = ["&", ";", ",", ")"].map(
  (delimiter) => `https://delimiter-user:delimiter-pass${delimiter}tail@userinfo.example.test/index.json`,
);
const STRICT_NESTED_USERINFO_URLS = [
  "https://registry.test/?next=https://john.doe outer-secret@evil.test/x",
  "https://registry.test/?next=https://localhost localhost-secret@evil.test/x",
  "https://registry.test/?next=https://xn--audit-user idn-secret@evil.test/x",
  "https://registry.test/?next=https://[::1] ipv6-secret@evil.test/x",
] as const;
const TOP_LEVEL_STRUCTURAL_URLS = [
  ["https://decoy@R3SECRET@host.test/x", "https://host.test/x"],
  ["https://first@second:R3PASS@host.test/x", "https://host.test/x"],
  [
    "https://outer-user:outer-pass@host.test/?next=https://nested-user:nested-pass@evil.test/x",
    "https://host.test/?next=https://evil.test/x",
  ],
  [
    "https://outer-r3:R3OUT@host.test/?next=https://decoy@nested:R3NEST@evil.test/x",
    "https://host.test/?next=https://evil.test/x",
  ],
  ["https://r3 soft-user@host.test/x", "https://host.test/x"],
  ...["&", ";", ",", ")"].map(
    (delimiter) => [`https://r3-user:r3-pass${delimiter}tail@host.test/x`, "https://host.test/x"] as const,
  ),
] as const;
const BACKSLASH = "\\";
const SPECIAL_DIAGNOSTIC_CREDENTIAL_URLS = [
  `https:${BACKSLASH}${BACKSLASH}special-user:special-pass@host.test/x`,
  `https:${BACKSLASH}special-user:special-pass@host.test/x`,
  `https:/${BACKSLASH}special-user:special-pass@host.test/x`,
  `https:${BACKSLASH}/special-user:special-pass@host.test/x`,
  "https:///special-user:special-pass@host.test/x",
  "https:special-user:special-pass@host.test/x",
];
const SAFE_SPECIAL_DIAGNOSTIC_URLS = [
  `fetch https:${BACKSLASH}${BACKSLASH}safe.test${BACKSLASH}path failed`,
  `fetch https:${BACKSLASH}${BACKSLASH}safe.test user@example.com`,
  `fetch https:${BACKSLASH}safe.test/path failed`,
  `fetch https:${BACKSLASH}safe.test user@example.com`,
  `fetch https:/${BACKSLASH}safe.test/path failed`,
  `fetch https:/${BACKSLASH}safe.test user@example.com`,
  `fetch https:${BACKSLASH}/safe.test/path failed`,
  `fetch https:${BACKSLASH}/safe.test user@example.com`,
  "fetch https:///safe.test/path failed",
  "fetch https:///safe.test user@example.com",
  "fetch https:safe.test/path failed",
  "fetch https:safe.test user@example.com",
  "fetch https: safe.test user@example.com",
];
const STRICT_LITERAL_DELIMITER_URLS = ["&", ",", ";", ")"].map(
  (delimiter) => `https://registry.test/proxy/https://plain${delimiter}R4SECRET@evil.test/x`,
);

function wrapNestedQuery(value: string): string {
  return `https://registry.test/?${new URLSearchParams({ next: value }).toString()}`;
}

function wrapNestedQueryTimes(value: string, count: number): string {
  let nested = value;
  for (let depth = 0; depth < count; depth++) nested = wrapNestedQuery(nested);
  return nested;
}

function encodeURIComponentTimes(value: string, count: number): string {
  let encoded = value;
  for (let depth = 0; depth < count; depth++) encoded = encodeURIComponent(encoded);
  return encoded;
}

function fixtureAt(values: readonly string[], index: number): string {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing registry credential fixture at index ${index}`);
  return value;
}

const ENCODED_NESTED_CREDENTIALS = [
  "https://R4USER:R4PASS@evil.test/x",
  "https://decoy@R4REPEATED@evil.test/x",
  "https://R4USER:R4PASS@[::1]/x",
  "h\tttps://R4USER:R4PASS@evil.test/x",
  `https:${BACKSLASH}${BACKSLASH}R4USER:R4PASS@evil.test/x`,
];
const STRICT_ISOLATED_EQUALS_CREDENTIALS = [
  "https://plain&email=R5SECRET@evil.test/x",
  "https://plain,email=R5SECRET@evil.test/x",
  "https://plain;email=R5SECRET@evil.test/x",
  "https://plain)email=R5SECRET@evil.test/x",
  "https://plain&first=value;second=R5SECRET@evil.test/x",
];
const STRICT_ENCODED_URLS = [
  ...ENCODED_NESTED_CREDENTIALS.flatMap((nested) => [
    wrapNestedQuery(nested),
    wrapNestedQuery(encodeURIComponent(nested)),
    wrapNestedQuery(encodeURIComponent(encodeURIComponent(nested))),
  ]),
  "https://registry.test/#next=https://R4USER%3AR4PASS%40evil.test/x",
  "https://registry.test/#next=https%3A%2F%2FR4USER%253AR4PASS%2540evil.test%2Fx",
  "https://registry.test/proxy/https%3A%2F%2FR4USER%3AR4PASS%40evil.test%2Fx",
  `https://registry.test/?${new URLSearchParams([["https://R5KEY:R5KEYPASS@evil.test/x", "value"]]).toString()}`,
  ...STRICT_ISOLATED_EQUALS_CREDENTIALS.flatMap((nested) => [
    wrapNestedQuery(nested),
    wrapNestedQuery(encodeURIComponent(nested)),
  ]),
];
const STRICT_RECURSIVE_URL = wrapNestedQueryTimes("https://recursive-user:RECURSIVESECRET@evil.test/x", 10);
const STRICT_MALFORMED_PERCENT_URL = "https://registry.test/?next=h%ZZttps%3A%2F%2FR4USER%3AR4PASS%40evil.test%2Fx";
const STRICT_TRAILING_MALFORMED_PERCENT_URL =
  "https://registry.test/?next=https%3A%2F%2FR4USER%3AR4PASS%40evil.test%2Fx%ZZ";
const STRICT_COUNT_EXHAUSTION_URL = `https://registry.test/#${[
  ...Array.from({ length: 140 }, (_, index) => `https://safe-${index}.test/x`),
  encodeURIComponent("https://count-user:COUNTSECRET@evil.test/x"),
].join(",")}`;
const STRICT_BYTE_EXHAUSTION_URL = wrapNestedQuery(
  `${"a".repeat(70_000)}${encodeURIComponent("https://byte-user:BYTESECRET@evil.test/x")}`,
);
const STRICT_LIMIT_AND_MALFORMED_URLS = [
  STRICT_RECURSIVE_URL,
  STRICT_MALFORMED_PERCENT_URL,
  STRICT_TRAILING_MALFORMED_PERCENT_URL,
  STRICT_COUNT_EXHAUSTION_URL,
  STRICT_BYTE_EXHAUSTION_URL,
];
const STRICT_DEPTH_8_SAFE_URL = wrapNestedQueryTimes("https://depth-safe.test/x", 8);
const STRICT_DEPTH_9_EXHAUSTION_URL = wrapNestedQueryTimes("https://depth-safe.test/x", 9);
const STRICT_DEPTH_8_CREDENTIAL_URL = wrapNestedQueryTimes("https://depth-user:DEPTHSECRET@evil.test/x", 8);
const STRICT_AUTHORITY_DECODE_8_URL = `https://registry.test/#next=https://ENCODEUSER${encodeURIComponentTimes(":ENCODEPASS@", 8)}evil.test/x`;
const STRICT_AUTHORITY_DECODE_9_URL = `https://registry.test/#next=https://ENCODEUSER${encodeURIComponentTimes(":ENCODEPASS@", 9)}evil.test/x`;
const STRICT_MIXED_DEPTH_8_SAFE_URL = wrapNestedQueryTimes(encodeURIComponentTimes("https://mixed-safe.test/x", 4), 4);
const STRICT_MIXED_DEPTH_8_CREDENTIAL_URL = wrapNestedQueryTimes(
  encodeURIComponentTimes("https://mixed-user:MIXEDSECRET@evil.test/x", 4),
  4,
);
const STRICT_MIXED_DEPTH_9_EXHAUSTION_URL = wrapNestedQueryTimes(
  encodeURIComponentTimes("https://mixed-safe.test/x", 5),
  4,
);
const R6_ENCODED_CREDENTIAL_URL = "https%3A%2F%2FR5USER%3AR5PASS%40evil.test%2Fx";
const R6_MIXED_LAYER_COMPONENT = `https://safe.test:bad,${R6_ENCODED_CREDENTIAL_URL}`;
const STRICT_MIXED_LAYER_URLS = [
  `https://registry.test/proxy/${R6_MIXED_LAYER_COMPONENT}`,
  `https://registry.test/#${R6_MIXED_LAYER_COMPONENT}`,
  wrapNestedQuery(R6_MIXED_LAYER_COMPONENT),
  `https://registry.test/#https://first.test:bad,https://second.test:worse,${R6_ENCODED_CREDENTIAL_URL}`,
];
const STRICT_TOP_AND_MIXED_LAYER_URL = `https://R6TOPUSER:R6TOPPASS@registry.test/proxy/${R6_MIXED_LAYER_COMPONENT}`;
const INVALID_UTF8_OCTETS = ["%FF", "%C0%AF", "%ED%A0%80"] as const;
const SAFE_INVALID_UTF8_URLS = INVALID_UTF8_OCTETS.flatMap((octets) => [
  `https://registry.test/path/${octets}/notes`,
  `https://registry.test/?note=${octets}`,
  `https://registry.test/#note=${octets}`,
]);
const STRICT_INVALID_UTF8_CREDENTIAL_URLS = INVALID_UTF8_OCTETS.flatMap((octets) => [
  `https://registry.test/proxy/${octets},${R6_ENCODED_CREDENTIAL_URL}`,
  `https://registry.test/#${octets},${R6_ENCODED_CREDENTIAL_URL}`,
  `https://registry.test/?next=${octets}${R6_ENCODED_CREDENTIAL_URL}`,
  `https://registry.test/#https://${octets}UTF8USER%3AUTF8PASS%40evil.test/x`,
]);
const R7_ENCODED_CREDENTIAL_URL = "https%3A%2F%2FLEAKUSER%3ALEAKPASS%40evil.test%2Fx";
const STRICT_FALLBACK_CREDENTIAL_URLS = [
  `https://safe.test:bad,${R7_ENCODED_CREDENTIAL_URL}`,
  `https://safe.test:99999,${R7_ENCODED_CREDENTIAL_URL}`,
  `arbitrary prefix,${R7_ENCODED_CREDENTIAL_URL}`,
  `ftp://safe.test/catalog?next=${R7_ENCODED_CREDENTIAL_URL}`,
] as const;
const SAFE_FALLBACK_URLS = [
  "https://safe.test:bad,https%3A%2F%2Fnested-safe.test%2Fx",
  "https://safe.test:99999,https%3A%2F%2Fnested-safe.test%2Fx",
  "arbitrary prefix,https%3A%2F%2Fnested-safe.test%2Fx",
  "ftp://safe.test/catalog?next=https%3A%2F%2Fnested-safe.test%2Fx",
] as const;
const FALLBACK_CANDIDATE_128_SAFE_URL = `arbitrary prefix,${Array.from(
  { length: 128 },
  (_, index) => `https://fallback-safe-${index}.test/x`,
).join(",")}`;
const FALLBACK_CANDIDATE_129_EXHAUSTION_URL = `${FALLBACK_CANDIDATE_128_SAFE_URL},https://fallback-safe-128.test/x`;
const FALLBACK_BYTE_PREFIX = "arbitrary prefix https://fallback-byte-safe.test/";
const FALLBACK_BYTE_65536_SAFE_URL = `${FALLBACK_BYTE_PREFIX}${"a".repeat(65_536 - FALLBACK_BYTE_PREFIX.length)}`;
const FALLBACK_BYTE_65537_EXHAUSTION_URL = `${FALLBACK_BYTE_65536_SAFE_URL}a`;
const STRICT_CANDIDATE_128_SAFE_URL = `https://registry.test/#${Array.from(
  { length: 128 },
  (_, index) => `https://safe-${index}.test/x`,
).join(",")}`;
const STRICT_CANDIDATE_129_EXHAUSTION_URL = `https://registry.test/#${Array.from(
  { length: 129 },
  (_, index) => `https://safe-${index}.test/x`,
).join(",")}`;
const STRICT_BYTE_PREFIX = "https://byte-safe.test/";
const STRICT_BYTE_65536_SAFE_URL = `https://registry.test/#${STRICT_BYTE_PREFIX}${"a".repeat(
  65_536 - STRICT_BYTE_PREFIX.length,
)}`;
const STRICT_BYTE_65537_EXHAUSTION_URL = `${STRICT_BYTE_65536_SAFE_URL}a`;
const SAFE_NON_URL_65537_URL = `https://registry.test/#${"a".repeat(65_537)}`;
const SAFE_STRICT_COMPONENT_URLS = [
  "https://registry.test/proxy/user:pass@notes/path",
  `https://registry.test/?${new URLSearchParams([
    ["next", "https://safe-one.test/x"],
    ["email", "user@example.com"],
    ["next", "https://safe-two.test/x"],
  ]).toString()}`,
  "https://registry.test/#owner=user@example.com;next=https://safe.test/x",
  wrapNestedQuery("https://safe.test/x"),
  wrapNestedQuery(encodeURIComponent("https://safe.test/x")),
  `https://registry.test/?${new URLSearchParams([
    ["https://safe-key.test/x", "value"],
    ["user@example.com", "value"],
  ]).toString()}`,
];
const CONFIG_LOAD_CONTROL_URLS = CONTROL_CHARACTERS.flatMap((control) => {
  const whole = `https:${control}//${USERNAME}:${PASSWORD}@load.example.test/index.json`;
  return [whole, `https://safe.test/?next=${whole}`];
});
const SAFE_REDACTION_NEGATIVE_CONTROLS = [
  "visit https://safe.test then email user@example.com",
  "https://registry.test/?redirect=https://safe.test&email=user@example.com",
  "https://registry.test/redirect/https://safe.test/path/user@example.com",
  "https://registry.test/#redirect=https://safe.test&email=user@example.com",
  "visit https://safe.test, then email user@example.com",
  "https://registry.test/https://safe.test;owner=user@example.com",
  "visit (https://safe.test) then email user@example.com",
  "https://registry.test/?redirect=https://safe.test,email=user@example.com",
  "https://registry.test/?redirect=https://safe.test;owner=user@example.com",
  "https://registry.test/?redirect=(https://safe.test)&email=user@example.com",
  "visit https://safe.test:bad then email user@example.com",
  "visit https://safe.test:bad user@example.com",
] as const;
const ADVERSARIAL_CREDENTIAL_URLS = [
  `https://safe.example.test/?next=https://${USERNAME}:${PASSWORD}@errors.example.test/private`,
  `https://safe.example.test/redirect/https://${USERNAME}:${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}:\t${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}:\r${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}:\n${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}: ${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}"@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}'@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}\`@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}<@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}>@errors.example.test/private`,
] as const;

const SAVE_BOUNDARY_UNSAFE_URLS = [
  CREDENTIAL_URL,
  `https://${USERNAME}@registry.example.test/index.json`,
  `https://:${PASSWORD}@registry.example.test/index.json`,
  ADVERSARIAL_CREDENTIAL_URLS[0],
  ADVERSARIAL_CREDENTIAL_URLS[1],
  ...CONTROL_SCHEME_CREDENTIAL_URLS,
  ...NESTED_CONTROL_SCHEME_CREDENTIAL_URLS,
  ...STRICT_NESTED_USERINFO_URLS,
  ...STRICT_LITERAL_DELIMITER_URLS,
  ...STRICT_ENCODED_URLS,
  ...STRICT_LIMIT_AND_MALFORMED_URLS,
  ...STRICT_MIXED_LAYER_URLS,
  ...STRICT_INVALID_UTF8_CREDENTIAL_URLS,
] as const;

const PROVIDER_BOUNDARY_UNSAFE_URLS = [
  CREDENTIAL_URL,
  ...CONTROL_SCHEME_CREDENTIAL_URLS,
  EXACT_NESTED_SCHEME_CONTROL_URL,
  ...STRICT_NESTED_USERINFO_URLS,
  ...STRICT_LITERAL_DELIMITER_URLS,
  ...STRICT_ENCODED_URLS,
  ...STRICT_LIMIT_AND_MALFORMED_URLS,
  ...STRICT_MIXED_LAYER_URLS,
  ...STRICT_INVALID_UTF8_CREDENTIAL_URLS,
  ...STRICT_FALLBACK_CREDENTIAL_URLS,
] as const;

const PERSISTED_BOUNDARY_UNSAFE_URLS = [
  EXACT_SCHEME_CONTROL_URL,
  EXACT_NESTED_SCHEME_CONTROL_URL,
  ...CONFIG_LOAD_CONTROL_URLS,
  ...STRICT_NESTED_USERINFO_URLS,
  fixtureAt(STRICT_LITERAL_DELIMITER_URLS, 1),
  fixtureAt(STRICT_ENCODED_URLS, 1),
  STRICT_RECURSIVE_URL,
  STRICT_MALFORMED_PERCENT_URL,
  fixtureAt(STRICT_MIXED_LAYER_URLS, 1),
  fixtureAt(STRICT_INVALID_UTF8_CREDENTIAL_URLS, 1),
] as const;

function expectCredentialsAbsent(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of [
    USERNAME,
    PASSWORD,
    "audit-user",
    "audit-pass",
    "nested-user",
    "nested-pass",
    "soft-user-secret",
    "delimiter-user",
    "delimiter-pass",
    "outer-secret",
    "localhost-secret",
    "idn-secret",
    "ipv6-secret",
    "R3SECRET",
    "R3PASS",
    "R3OUT",
    "R3NEST",
    "outer-user",
    "outer-pass",
    "r3 soft-user",
    "r3-user",
    "r3-pass",
    "special-user",
    "special-pass",
    "R4SECRET",
    "R4USER",
    "R4PASS",
    "R4REPEATED",
    "RECURSIVESECRET",
    "COUNTSECRET",
    "BYTESECRET",
    "DEPTHSECRET",
    "ENCODEUSER",
    "ENCODEPASS",
    "R5SECRET",
    "MIXEDSECRET",
    "R5KEY",
    "R5KEYPASS",
    "R5USER",
    "R5PASS",
    "R6TOPUSER",
    "R6TOPPASS",
    "UTF8USER",
    "UTF8PASS",
    "LEAKUSER",
    "LEAKPASS",
  ]) {
    expect(serialized).not.toContain(marker);
  }
  expect(serialized).not.toContain(CREDENTIAL_URL);
}

function configPath(): string {
  return path.join(storage.configDir, "akm", "config.json");
}

function expectNoPersistedCredentials(): void {
  expectCredentialsAbsent(fs.existsSync(configPath()) ? fs.readFileSync(configPath(), "utf8") : "");
}

function saveRegistryUrl(url: string, name = "private"): void {
  saveConfig({ ...DEFAULT_CONFIG, registries: [{ url, name }] });
}

async function expectProviderRefusal(urls: readonly string[]): Promise<void> {
  const requested: string[] = [];
  const results = await withMockedFetch(
    async () => {
      const captured = [];
      for (const providerType of ["static-index", "skills-sh"] as const) {
        const factory = resolveRegistryProviderFactory(providerType);
        if (!factory) throw new Error(`Built-in registry provider ${providerType} is not registered`);
        for (const url of urls) {
          captured.push(await factory({ url, name: `${providerType}-private` }).search({ query: "needle", limit: 20 }));
        }
      }
      return captured;
    },
    (url) => {
      requested.push(url);
      return new Response("{}");
    },
  );

  expect(requested).toEqual([]);
  for (const result of results) {
    expect(result.hits).toEqual([]);
    expect(result.warnings?.[0]?.toLowerCase()).toContain("credential");
    expectCredentialsAbsent(result);
  }
}

function expectConfiguredProjectionsSafe(url: string): void {
  const registries = [{ url, name: "private", provider: "static-index" as const }];
  const config = { ...DEFAULT_CONFIG, registries };
  expectCredentialsAbsent(getConfigValue(config, "registries"));
  expectCredentialsAbsent(listConfig(config));
  expectCredentialsAbsent(formatRegistryListPlain({ registries }));
  expectCredentialsAbsent(formatRegistryRemovePlain({ removed: true, entry: registries[0] }));
  expectCredentialsAbsent(formatInfoPlain({ version: "test", registries }));
  expectCredentialsAbsent(collectEgressAdvisory({ registries }));
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage({ AKM_REGISTRY_URL: undefined });
});

afterEach(() => {
  clearLogFile();
  storage.cleanup();
});

describe("registry credential-bearing URL mutation boundaries", () => {
  test("the shared save boundary drops the complete credential corpus instead of persisting it", () => {
    for (const url of SAVE_BOUNDARY_UNSAFE_URLS) {
      try {
        saveRegistryUrl(url);
        expect(loadConfig().registries ?? []).toEqual([]);
      } catch (err) {
        expect(String(err)).not.toContain("credential");
        expect(String(err)).toContain("http:// or https://");
      }
      resetConfigCache();
    }
  });

  test("config set rejects representative credential classes before persistence", async () => {
    const invocations = [
      [
        "config",
        "set",
        "registries",
        JSON.stringify([{ url: EXACT_NESTED_SCHEME_CONTROL_URL, name: "private" }]),
        "--format=json",
      ],
      [
        "config",
        "set",
        "registries",
        JSON.stringify([{ url: fixtureAt(STRICT_ENCODED_URLS, 0), name: "private" }]),
        "--format=json",
      ],
    ];

    for (const argv of invocations) {
      const result = await runCliCapture(argv);
      expect(result.code).toBe(2);
      expect(result.stderr.toLowerCase()).toContain("credential");
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);
      expectNoPersistedCredentials();
    }
  });

  test("registry add accepts a credentialed URL, warning with the credential redacted (0.9.12)", async () => {
    const invocations = [
      ["registry", "add", CREDENTIAL_URL, "--verbose", "--format=json"],
      ["registry", "add", STRICT_NESTED_USERINFO_URLS[0], "--format=json"],
      ["registry", "add", fixtureAt(STRICT_MIXED_LAYER_URLS, 0), "--format=json"],
      ["registry", "add", fixtureAt(STRICT_INVALID_UTF8_CREDENTIAL_URLS, 0), "--format=json"],
    ];

    for (const argv of invocations) {
      const url = argv[2] as string;
      expect(formatRegistryUrl(url)).not.toContain(url);
      expectCredentialsAbsent(formatRegistryUrl(url));

      const result = await runCliCapture(argv);
      expect(result.code).toBe(0);
      expect(result.stderr.toLowerCase()).toContain("credential");
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);

      const parsed = JSON.parse(result.stdout) as { added: boolean; registries: Array<{ url: string }> };
      expect(parsed.added).toBe(true);
      expect(parsed.registries.some((r) => r.url === formatRegistryUrl(url))).toBe(true);
    }
  });

  test("registry remove does not echo a credential-bearing target in its JSON error", async () => {
    const result = await runCliCapture(["registry", "remove", CREDENTIAL_URL, "--yes", "--format=json"]);

    expect(result.code).toBe(1);
    expectCredentialsAbsent(result.stdout);
    expectCredentialsAbsent(result.stderr);
  });

  test("ordinary invalid UTF-8 octets remain exact across save and load", () => {
    for (const url of SAFE_INVALID_UTF8_URLS) {
      saveRegistryUrl(url, "invalid-utf8-safe");
      expect(loadConfig().registries?.[0]?.url).toBe(url);
    }
  });

  test("add, set, save, and load preserve safe strict component controls", async () => {
    const add = await runCliCapture(["registry", "add", fixtureAt(SAFE_STRICT_COMPONENT_URLS, 0), "--format=json"]);
    expect(add.code).toBe(0);
    const set = await runCliCapture([
      "config",
      "set",
      "registries",
      JSON.stringify([{ url: fixtureAt(SAFE_STRICT_COMPONENT_URLS, 1), name: "safe-components" }]),
      "--format=json",
    ]);
    expect(set.code).toBe(0);

    for (const url of SAFE_STRICT_COMPONENT_URLS) {
      saveRegistryUrl(url, "safe-components");
      expect(loadConfig().registries?.[0]?.url).toBe(url);
    }
  });
});

describe("already-persisted registry credentials load and stay redacted", () => {
  test("CLI config, registry, info, and health JSON never echo userinfo; search skips the entry with a credential warning", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      registries: [{ url: CREDENTIAL_URL, name: "private", provider: "static-index" }],
    });

    const displayInvocations = [
      ["registry", "list", "--format=json"],
      ["config", "list", "--format=json"],
      ["info", "--format=json"],
      ["health", "--format=json"],
    ];
    for (const argv of displayInvocations) {
      const result = await runCliCapture(argv);
      expect(result.code).not.toBe(78);
      expect(result.code).not.toBe(70);
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);
    }

    const searchInvocations = [
      ["search", "needle", "--from", "registry", "--verbose", "--format=json"],
      ["search", "needle", "--from", "all", "--verbose", "--format=json"],
    ];
    for (const argv of searchInvocations) {
      const result = await runCliCapture(argv);
      expect(result.code).toBe(0);
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);
      expect(result.stdout.toLowerCase()).toContain("credential");
    }
  });

  test("every persisted credential class loads without leaking a credential into registry list", async () => {
    for (const url of PERSISTED_BOUNDARY_UNSAFE_URLS) {
      writeSandboxConfig({ registries: [{ url, name: "private", provider: "static-index" }] });
      const result = await runCliCapture(["registry", "list", "--verbose", "--format=json"]);
      expect([0, 78]).toContain(result.code);
      expect(result.code).not.toBe(70);
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);
    }
  });
});

describe("registry provider, search, warning, and log boundaries", () => {
  test("credential-free static-index and skills-sh requests preserve their existing behavior", async () => {
    const staticUrl = "https://registry.example.test/deep/index.json?channel=beta";
    const skillsUrl = "https://skills.example.test/catalog";
    const requested: string[] = [];
    const result = await withMockedFetch(
      () =>
        searchRegistry("needle", {
          registries: [
            { url: staticUrl, name: "static", provider: "static-index" },
            { url: skillsUrl, name: "skills", provider: "skills-sh" },
          ],
        }),
      (url) => {
        requested.push(url);
        if (url === staticUrl) {
          return new Response(
            JSON.stringify({
              version: 3,
              updatedAt: "2026-01-01T00:00:00Z",
              stashes: [{ id: "npm:needle", name: "needle", ref: "needle", source: "npm" }],
            }),
          );
        }
        return new Response(
          JSON.stringify({ skills: [{ id: "org/repo/needle", name: "needle", installs: 1, source: "org/repo" }] }),
        );
      },
    );

    expect(requested).toContain(staticUrl);
    expect(requested).toContain(`${skillsUrl}/api/search?q=needle&limit=20`);
    expect(result.hits).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  test("static-index and skills-sh refuse credential-bearing URLs without fetching", async () => {
    const requested: string[] = [];
    const result = await withMockedFetch(
      () =>
        searchRegistry("needle", {
          registries: [
            { url: CREDENTIAL_URL, name: "static-private", provider: "static-index" },
            { url: CREDENTIAL_URL.replace("index.json", "skills"), name: "skills-private", provider: "skills-sh" },
          ],
        }),
      (url) => {
        requested.push(url);
        return new Response(JSON.stringify({ version: 3, updatedAt: "2026-01-01T00:00:00Z", stashes: [] }));
      },
    );

    expect(requested).toEqual([]);
    expect(result.hits).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((warning) => warning.toLowerCase().includes("credential"))).toBe(true);
    expectCredentialsAbsent(result);
  });

  test("both built-in providers refuse the complete unsafe corpus before cache or fetch", async () => {
    await expectProviderRefusal(PROVIDER_BOUNDARY_UNSAFE_URLS);
  });

  test("both providers accept ordinary invalid UTF-8 octets without throwing", async () => {
    for (const providerType of ["static-index", "skills-sh"]) {
      const factory = resolveRegistryProviderFactory(providerType);
      if (!factory) throw new Error(`Built-in registry provider ${providerType} is not registered`);
      for (const url of SAFE_INVALID_UTF8_URLS) {
        const requested: string[] = [];
        const result = await withMockedFetch(
          () => factory({ url, name: `${providerType}-invalid-utf8-safe` }).search({ query: "needle", limit: 20 }),
          (requestedUrl) => {
            requested.push(requestedUrl);
            return new Response(
              providerType === "static-index"
                ? JSON.stringify({ version: 3, updatedAt: "2026-01-01T00:00:00Z", stashes: [] })
                : JSON.stringify({ skills: [] }),
            );
          },
        );

        expect(requested).toHaveLength(1);
        expect(result.warnings ?? []).toEqual([]);
      }
    }
  });

  test("both providers preserve safe query arrays, paths, fragments, and encoded nested URLs", async () => {
    for (const providerType of ["static-index", "skills-sh"]) {
      const factory = resolveRegistryProviderFactory(providerType);
      if (!factory) throw new Error(`Built-in registry provider ${providerType} is not registered`);
      for (const url of SAFE_STRICT_COMPONENT_URLS) {
        const requested: string[] = [];
        const result = await withMockedFetch(
          () => factory({ url, name: `${providerType}-safe-components` }).search({ query: "needle", limit: 20 }),
          (requestedUrl) => {
            requested.push(requestedUrl);
            return new Response(
              providerType === "static-index"
                ? JSON.stringify({ version: 3, updatedAt: "2026-01-01T00:00:00Z", stashes: [] })
                : JSON.stringify({ skills: [] }),
            );
          },
        );

        expect(requested.length).toBe(1);
        expect(result.warnings ?? []).toEqual([]);
      }
    }
  });

  test("AKM_REGISTRY_URL ignores userinfo without returning or warning with secrets", () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const resolved = withEnvSync(
        {
          AKM_REGISTRY_URL: `${CREDENTIAL_URL},::${CREDENTIAL_URL},static-index::ftp://${USERNAME}:${PASSWORD}@registry.example.test`,
        },
        () => resolveRegistries(),
      );
      expect(resolved).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
    expectCredentialsAbsent(warnings);
  });

  test("fetch error objects sanitize nested, control, and punctuation userinfo before response and log sinks", async () => {
    const logPath = path.join(storage.root, "registry.log");
    setLogFile(logPath);

    const result = await withMockedFetch(
      () =>
        searchRegistry("needle", {
          registries: [{ url: "https://skills.example.test", name: "skills", provider: "skills-sh" }],
        }),
      () => {
        throw new Error(`fetch failed:\n${ADVERSARIAL_CREDENTIAL_URLS.join("\n")}`);
      },
    );
    for (const warning of result.warnings) warn(warning);

    expectCredentialsAbsent(result);
    expectCredentialsAbsent(fs.readFileSync(logPath, "utf8"));
  });

  test("control-obfuscated schemes are removed from response warnings and file logs", async () => {
    const logPath = path.join(storage.root, "registry-controls.log");
    setLogFile(logPath);
    const corpus = [
      ...CONTROL_SCHEME_CREDENTIAL_URLS,
      ...NESTED_CONTROL_SCHEME_CREDENTIAL_URLS,
      ...SOFT_DELIMITER_USERNAME_URLS,
      ...PASSWORD_DELIMITER_URLS,
      ...TOP_LEVEL_STRUCTURAL_URLS.map(([url]) => url),
      ...SPECIAL_DIAGNOSTIC_CREDENTIAL_URLS,
    ].join("\n");

    const result = await withMockedFetch(
      () =>
        searchRegistry("needle", {
          registries: [{ url: "https://skills.example.test", name: "skills", provider: "skills-sh" }],
        }),
      () => {
        throw new Error(`control-obfuscated fetch failures:\n${corpus}`);
      },
    );
    for (const warning of result.warnings) warn(warning);

    expectCredentialsAbsent(result);
    expectCredentialsAbsent(fs.readFileSync(logPath, "utf8"));
  });

  test("normal and registry-only CLI search JSON never echo URLs from fetch errors", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      registries: [{ url: "https://registry.example.test/index.json", name: "safe" }],
    });

    const results = await withMockedFetch(
      async () => [
        await runCliCapture(["search", "needle", "--from", "registry", "--verbose", "--format=json"]),
        await runCliCapture(["search", "needle", "--from", "all", "--verbose", "--format=json"]),
      ],
      () => {
        throw new Error(`fetch failed for ${CREDENTIAL_URL}`);
      },
    );

    for (const result of results) {
      expect(result.code).toBe(0);
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);
    }
  });

  test("setup registry discovery refuses userinfo before its fetch boundary", async () => {
    const requested: string[] = [];
    const stashSets = await withMockedFetch(
      () =>
        Promise.all(
          [CREDENTIAL_URL, EXACT_SCHEME_CONTROL_URL, EXACT_NESTED_SCHEME_CONTROL_URL].map((url) =>
            loadSetupStashes(url),
          ),
        ),
      (url) => {
        requested.push(url);
        return new Response("{}");
      },
    );

    expect(requested).toEqual([]);
    for (const stashes of stashSets) {
      expect(stashes.length).toBeGreaterThan(0);
      expectCredentialsAbsent(stashes);
    }
  });
});

describe("registry URLs are safe in plain, structured, and health projections", () => {
  test("configured credential classes are safe across every public projection", () => {
    const representatives = [
      CREDENTIAL_URL,
      EXACT_SCHEME_CONTROL_URL,
      EXACT_NESTED_SCHEME_CONTROL_URL,
      ...STRICT_NESTED_USERINFO_URLS,
      ...TOP_LEVEL_STRUCTURAL_URLS.map(([url]) => url),
      STRICT_TOP_AND_MIXED_LAYER_URL,
      fixtureAt(STRICT_LITERAL_DELIMITER_URLS, 2),
      fixtureAt(STRICT_ENCODED_URLS, 2),
      STRICT_RECURSIVE_URL,
    ];
    for (const url of representatives) expectConfiguredProjectionsSafe(url);
  });

  test("the formatter preserves credential-free paths/queries and only removes userinfo", () => {
    const ordinary = "https://registry.example.test/deep/index.json?channel=beta#latest";
    expect(formatRegistryUrl(ordinary)).toBe(ordinary);
    expect(
      formatRegistryUrl(`https://${USERNAME}:${PASSWORD}@registry.example.test/deep/index.json?channel=beta#latest`),
    ).toBe("https://registry.example.test/deep/index.json?channel=beta#latest");
    expectCredentialsAbsent(formatRegistryError(new Error(`request failed: ${CREDENTIAL_URL}?retry=1`)));
  });

  test("the error sanitizer scans nested URL starts and delimiter-heavy userinfo", () => {
    expect(formatRegistryUrl(STRICT_TOP_AND_MIXED_LAYER_URL)).toBe("(invalid registry URL)");

    for (const unsafe of ADVERSARIAL_CREDENTIAL_URLS) {
      expectCredentialsAbsent(redactCredentialBearingUrls(`request failed for ${unsafe}`));
      expectCredentialsAbsent(formatRegistryUrl(unsafe));
    }

    expect(
      redactCredentialBearingUrls(
        `outer https://safe.example.test/?next=https://${USERNAME}:${PASSWORD}@errors.example.test/private`,
      ),
    ).toBe("outer https://safe.example.test/?next=https://errors.example.test/private");
    expect(
      redactCredentialBearingUrls(
        `outer https://safe.example.test/redirect/https://${USERNAME}:${PASSWORD}@errors.example.test/private`,
      ),
    ).toBe("outer https://safe.example.test/redirect/https://errors.example.test/private");
  });

  test("configured and nested URLs with controls anywhere in the scheme fail closed", () => {
    for (const unsafe of [...CONTROL_SCHEME_CREDENTIAL_URLS, ...NESTED_CONTROL_SCHEME_CREDENTIAL_URLS]) {
      expect(hasRegistryUrlCredentials(unsafe)).toBe(true);
      expectCredentialsAbsent(formatRegistryUrl(unsafe));
      expectCredentialsAbsent(redactCredentialBearingUrls(`diagnostic: ${unsafe}`));
    }
  });

  test("strict configured detection rejects nested host-shaped usernames", () => {
    for (const url of STRICT_NESTED_USERINFO_URLS) {
      expect(hasRegistryUrlCredentials(url)).toBe(true);
      expectCredentialsAbsent(formatRegistryUrl(url));
    }
  });

  test("strict recursive detection rejects literal delimiter and encoded credentials with safe formatting", () => {
    for (const url of [...STRICT_LITERAL_DELIMITER_URLS, ...STRICT_ENCODED_URLS]) {
      expect(hasRegistryUrlCredentials(url)).toBe(true);
      expectCredentialsAbsent(formatRegistryUrl(url));
    }
  });

  test("strict recursive detection fails closed on malformed decoding and every inspection budget", () => {
    for (const url of STRICT_LIMIT_AND_MALFORMED_URLS) {
      expect(hasRegistryUrlCredentials(url)).toBe(true);
      const formatted = formatRegistryUrl(url);
      expect(
        ["RECURSIVESECRET", "R4USER", "R4PASS", "COUNTSECRET", "BYTESECRET"].some((marker) =>
          formatted.includes(marker),
        ),
      ).toBe(false);
    }
  });

  test("strict recursion accepts depth 8, detects credentials there, and fails closed at depth 9", () => {
    expect(hasRegistryUrlCredentials(STRICT_DEPTH_8_SAFE_URL)).toBe(false);
    expect(formatRegistryUrl(STRICT_DEPTH_8_SAFE_URL)).toBe(STRICT_DEPTH_8_SAFE_URL);

    expect(hasRegistryUrlCredentials(STRICT_DEPTH_8_CREDENTIAL_URL)).toBe(true);
    expectCredentialsAbsent(formatRegistryUrl(STRICT_DEPTH_8_CREDENTIAL_URL));

    expect(hasRegistryUrlCredentials(STRICT_DEPTH_9_EXHAUSTION_URL)).toBe(true);
    expect(formatRegistryUrl(STRICT_DEPTH_9_EXHAUSTION_URL)).toBe("(invalid registry URL)");
  });

  test("strict authority decoding catches credentials at layer 8 and fails closed at layer 9", () => {
    expect(hasRegistryUrlCredentials(STRICT_AUTHORITY_DECODE_8_URL)).toBe(true);
    expectCredentialsAbsent(formatRegistryUrl(STRICT_AUTHORITY_DECODE_8_URL));

    expect(hasRegistryUrlCredentials(STRICT_AUTHORITY_DECODE_9_URL)).toBe(true);
    expect(formatRegistryUrl(STRICT_AUTHORITY_DECODE_9_URL)).toBe("(invalid registry URL)");
  });

  test("strict depth is cumulative across recursive URLs and percent-decoding steps", () => {
    expect(hasRegistryUrlCredentials(STRICT_MIXED_DEPTH_8_SAFE_URL)).toBe(false);
    expect(formatRegistryUrl(STRICT_MIXED_DEPTH_8_SAFE_URL)).toBe(STRICT_MIXED_DEPTH_8_SAFE_URL);

    expect(hasRegistryUrlCredentials(STRICT_MIXED_DEPTH_8_CREDENTIAL_URL)).toBe(true);
    expectCredentialsAbsent(formatRegistryUrl(STRICT_MIXED_DEPTH_8_CREDENTIAL_URL));

    expect(hasRegistryUrlCredentials(STRICT_MIXED_DEPTH_9_EXHAUSTION_URL)).toBe(true);
    expect(formatRegistryUrl(STRICT_MIXED_DEPTH_9_EXHAUSTION_URL)).toBe("(invalid registry URL)");
  });

  test("strict inspection continues through mixed literal and encoded URL layers", () => {
    for (const url of STRICT_MIXED_LAYER_URLS) {
      expect(hasRegistryUrlCredentials(url)).toBe(true);
      expectCredentialsAbsent(formatRegistryUrl(url));
    }
  });

  test("strict fallback uses the bounded walker for unparseable and non-HTTP whole values", () => {
    for (const url of STRICT_FALLBACK_CREDENTIAL_URLS) {
      expect(hasRegistryUrlCredentials(url)).toBe(true);
      expectCredentialsAbsent(formatRegistryUrl(url));
    }
    for (const url of SAFE_FALLBACK_URLS) {
      expect(hasRegistryUrlCredentials(url)).toBe(false);
    }

    expect(hasRegistryUrlCredentials(FALLBACK_CANDIDATE_128_SAFE_URL)).toBe(false);
    expect(hasRegistryUrlCredentials(FALLBACK_CANDIDATE_129_EXHAUSTION_URL)).toBe(true);
    expect(hasRegistryUrlCredentials(FALLBACK_BYTE_65536_SAFE_URL)).toBe(false);
    expect(hasRegistryUrlCredentials(FALLBACK_BYTE_65537_EXHAUSTION_URL)).toBe(true);
  });

  test("invalid UTF-8 octets are non-throwing, exact when ordinary, and fail closed with credential evidence", () => {
    for (const url of SAFE_INVALID_UTF8_URLS) {
      expect(hasRegistryUrlCredentials(url)).toBe(false);
      expect(formatRegistryUrl(url)).toBe(url);
    }
    for (const url of STRICT_INVALID_UTF8_CREDENTIAL_URLS) {
      expect(hasRegistryUrlCredentials(url)).toBe(true);
      expectCredentialsAbsent(formatRegistryUrl(url));
    }
  });

  test("strict candidate budget accepts 128 candidates and fails closed on candidate 129", () => {
    expect(hasRegistryUrlCredentials(STRICT_CANDIDATE_128_SAFE_URL)).toBe(false);
    expect(formatRegistryUrl(STRICT_CANDIDATE_128_SAFE_URL)).toBe(STRICT_CANDIDATE_128_SAFE_URL);

    expect(hasRegistryUrlCredentials(STRICT_CANDIDATE_129_EXHAUSTION_URL)).toBe(true);
    expect(formatRegistryUrl(STRICT_CANDIDATE_129_EXHAUSTION_URL)).toBe("(invalid registry URL)");
  });

  test("strict decoded-byte budget accepts 65536 bytes and fails closed on URL-like byte 65537", () => {
    expect(hasRegistryUrlCredentials(STRICT_BYTE_65536_SAFE_URL)).toBe(false);
    expect(formatRegistryUrl(STRICT_BYTE_65536_SAFE_URL)).toBe(STRICT_BYTE_65536_SAFE_URL);

    expect(hasRegistryUrlCredentials(STRICT_BYTE_65537_EXHAUSTION_URL)).toBe(true);
    expect(formatRegistryUrl(STRICT_BYTE_65537_EXHAUSTION_URL)).toBe("(invalid registry URL)");

    expect(hasRegistryUrlCredentials(SAFE_NON_URL_65537_URL)).toBe(false);
    expect(formatRegistryUrl(SAFE_NON_URL_65537_URL)).toBe(SAFE_NON_URL_65537_URL);
  });

  test("strict recursive inspection preserves safe query arrays, paths, fragments, and encoded nested URLs", () => {
    for (const url of SAFE_STRICT_COMPONENT_URLS) {
      expect(hasRegistryUrlCredentials(url)).toBe(false);
      expect(formatRegistryUrl(url)).toBe(url);
    }
  });

  test("whole formatter structurally clears all top-level userinfo before sanitizing nested URLs", () => {
    for (const [unsafe, expected] of TOP_LEVEL_STRUCTURAL_URLS) {
      expect(formatRegistryUrl(unsafe)).toBe(expected);
      expectCredentialsAbsent(formatRegistryUrl(unsafe));
    }
  });

  test.each(
    TOP_LEVEL_STRUCTURAL_URLS.map(([url]) => url),
  )("diagnostic redaction removes authority userinfo through the last @: %s", (unsafe) => {
    const diagnostic = `fetch failed for ${unsafe}`;
    expectCredentialsAbsent(redactCredentialBearingUrls(diagnostic));
    expectCredentialsAbsent(formatRegistryError(new Error(diagnostic)));
  });

  test.each(
    SPECIAL_DIAGNOSTIC_CREDENTIAL_URLS,
  )("diagnostic redaction recognizes WHATWG special-scheme spelling: %s", (unsafe) => {
    const diagnostic = `fetch failed for ${unsafe}`;
    expectCredentialsAbsent(redactCredentialBearingUrls(diagnostic));
    expectCredentialsAbsent(formatRegistryError(new Error(diagnostic)));
  });

  test.each(
    SAFE_SPECIAL_DIAGNOSTIC_URLS,
  )("diagnostic redaction preserves credential-free special-scheme spelling: %s", (ordinary) => {
    expect(redactCredentialBearingUrls(ordinary)).toBe(ordinary);
    expect(formatRegistryError(new Error(ordinary))).toContain(ordinary);
  });

  test.each(
    SOFT_DELIMITER_USERNAME_URLS,
  )("diagnostic redaction removes delimiter-heavy username-only userinfo: %s", (unsafe) => {
    const diagnostic = `fetch failed for ${unsafe}`;
    expect(hasRegistryUrlCredentials(diagnostic)).toBe(true);
    expectCredentialsAbsent(redactCredentialBearingUrls(diagnostic));
    expectCredentialsAbsent(formatRegistryError(new Error(diagnostic)));
  });

  test.each(PASSWORD_DELIMITER_URLS)("diagnostic redaction removes delimiter-heavy password userinfo: %s", (unsafe) => {
    const diagnostic = `fetch failed for ${unsafe}`;
    expect(hasRegistryUrlCredentials(diagnostic)).toBe(true);
    expectCredentialsAbsent(redactCredentialBearingUrls(diagnostic));
    expectCredentialsAbsent(formatRegistryError(new Error(diagnostic)));
  });

  test("credential-free user:pass@ data in a path, query, or fragment remains unchanged", () => {
    const ordinary =
      "request https://safe.example.test/path/user:pass@notes?next=user:pass@data#fragment-user:pass@value";
    expect(redactCredentialBearingUrls(ordinary)).toBe(ordinary);
  });

  test("safe URLs followed by email and delimiter text are preserved exactly", () => {
    for (const ordinary of SAFE_REDACTION_NEGATIVE_CONTROLS) {
      expect(redactCredentialBearingUrls(ordinary)).toBe(ordinary);
    }

    const configured = SAFE_REDACTION_NEGATIVE_CONTROLS.filter((value) => value.startsWith("https://registry.test"));
    for (const ordinary of configured) {
      expect(hasRegistryUrlCredentials(ordinary)).toBe(false);
      expect(formatRegistryUrl(ordinary)).toBe(ordinary);
    }
  });

  test("ordinary validated config remains unchanged", () => {
    expect(loadConfig().registries).toEqual(DEFAULT_CONFIG.registries);
  });

  test("serialized CLI/result/warning/error corpus contains no registry userinfo", async () => {
    const cli = await runCliCapture(["registry", "add", CREDENTIAL_URL, "--format=json"]);
    const requested: string[] = [];
    const result = await withMockedFetch(
      () => searchRegistry("needle", { registries: [{ url: CREDENTIAL_URL, name: "private" }] }),
      (url) => {
        requested.push(url);
        return new Response("{}");
      },
    );
    let configError: unknown;
    try {
      saveConfig({ ...DEFAULT_CONFIG, registries: [{ url: CREDENTIAL_URL }] });
    } catch (error) {
      configError = error;
    }
    const errorProjection =
      configError instanceof Error
        ? { name: configError.name, message: configError.message, stack: configError.stack, cause: configError.cause }
        : configError;

    expectCredentialsAbsent({ cli, result, requested, error: errorProjection });
  });
});
