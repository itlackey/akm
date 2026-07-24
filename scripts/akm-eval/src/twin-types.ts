declare const safeRelativePathBrand: unique symbol;
declare const sha256Brand: unique symbol;

/** A canonical, slash-separated path that cannot escape its snapshot root. */
export type SafeRelativePath = string & { readonly [safeRelativePathBrand]: true };

/** A lowercase hexadecimal SHA-256 digest. */
export type Sha256 = string & { readonly [sha256Brand]: true };

export type InstallationSnapshotEntryKind = "bundle" | "config" | "data";

export interface InstallationSnapshotEntry {
  kind: InstallationSnapshotEntryKind;
  path: SafeRelativePath;
  byteSize: number;
  sha256: Sha256;
  /** Source modification time retained for causal age/eligibility checks. */
  mtimeMs: number;
}

export interface ProducerIdentity {
  version: string;
  commit: string | null;
}

export interface InstallationSnapshotManifest {
  schemaVersion: 2;
  /** Canonical manifest hash; this is the source snapshot hash used by twin results. */
  snapshotFingerprint: Sha256;
  producer: ProducerIdentity;
  configFingerprint: Sha256;
  defaultBundle: string;
  /** Bundle IDs mapped to their roots inside the snapshot. */
  bundleRoots: Record<string, SafeRelativePath>;
  configPath: SafeRelativePath;
  dataDir: SafeRelativePath;
  entries: InstallationSnapshotEntry[];
}

/** Runtime paths produced by materializing one verified snapshot copy. */
export interface MaterializedInstallation {
  root: string;
  defaultBundle: string;
  bundleRoots: Record<string, string>;
  configPath: string;
  dataDir: string;
  env: Record<string, string>;
}

export type EndpointSamplerSetting = string | number | boolean | null;

export interface EndpointFingerprint {
  schemaVersion: 1;
  endpointId: string;
  /** Canonical hash of model, prompt, and serving settings. */
  servingFingerprint: Sha256;
  modelId: string;
  modelSha256: Sha256;
  /** Prompt/template identity attested by the endpoint operator. */
  promptFingerprint: Sha256;
  quantization: string;
  contextLimit: number;
  serverImplementation: string;
  serverVersion: string;
  samplerSettings: Record<string, EndpointSamplerSetting>;
}

export type TwinArm = "control" | "treatment";
export type TwinControlPolicy = "no-improve";
export type TwinTreatmentPolicy = "current" | "candidate-only";

export interface TwinDecisionCriteria {
  minimumDeterministicLift: number;
  protectedLossMargin: number;
  maxTreatmentTokens: number;
  maxTreatmentModelCalls: number;
  maxTreatmentDurationMs: number;
  requiredSampleCount: number;
}

export interface TwinExperimentPolicy {
  schemaVersion: 2;
  control: TwinControlPolicy;
  treatment: TwinTreatmentPolicy;
  casesSource: "builtin" | "external";
  improveArgs: string[];
  commandTimeoutMs: number;
  protectedCaseIds: string[];
  protectedAssets: ProtectedAssetDeclaration[];
  criteria: TwinDecisionCriteria;
}

export interface ProtectedAssetDeclaration {
  path: SafeRelativePath;
  sha256: Sha256;
}

export interface ProtectedAssetVerification extends ProtectedAssetDeclaration {
  actualSha256: Sha256 | null;
  status: "preserved" | "modified" | "missing" | "unavailable";
}

export interface EndpointAssignment {
  arm: TwinArm;
  endpointId: string;
}

export interface TwinArmIdentity {
  runtimeProducer: ProducerIdentity;
  snapshotProducer: ProducerIdentity;
  configFingerprint: Sha256;
  promptFingerprint: Sha256 | null;
  modelFingerprint: Sha256 | null;
}

export interface TwinMutationSummary {
  initialManifestFingerprint: Sha256 | null;
  finalManifestFingerprint: Sha256 | null;
  addedFileCount: number;
  modifiedFileCount: number;
  removedFileCount: number;
  modifiedDatabaseCount: number;
}

export interface TwinResourceMetrics {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Measured wall-clock duration of the improve subprocess. */
  wallDurationMs: number;
  /** Sum of model request durations from complete llm_usage rows. */
  modelCallDurationMs: number;
  tokensPerSecond: number | null;
  telemetryComplete: boolean;
  observedModelIds: string[];
}

export interface TwinArmResources {
  /** Whether the improve phase was expected to invoke an LLM. */
  llmWorkExpected: boolean;
  /** Improve-only telemetry. Indexing and evaluation are deliberately excluded. */
  improve: TwinResourceMetrics | null;
}

export interface TwinArmResult {
  identity: TwinArmIdentity;
  executedCaseCount: number;
  deterministicScore: number;
  mutations: TwinMutationSummary;
  resources: TwinArmResources;
  protectedAssets: ProtectedAssetVerification[];
  errors: string[];
}

export interface TwinCaseDelta {
  caseId: string;
  controlScore: number;
  treatmentScore: number;
  delta: number;
  controlPassed: boolean;
  treatmentPassed: boolean;
}

export interface TwinRegression {
  caseId: string;
  protected: boolean;
  controlScore: number;
  treatmentScore: number;
  reason: string;
}

export interface TwinArmArtifactPaths {
  metrics: string;
  privateArtifacts: {
    evalResult: string | null;
    caseResults: string | null;
    improveResult: string | null;
    finalManifest: string | null;
    sandboxRoot: string | null;
  } | null;
}

export interface TwinExperimentArtifactPaths {
  snapshotManifest: string | null;
  control: TwinArmArtifactPaths;
  treatment: TwinArmArtifactPaths;
}

export type TwinExperimentOutcome = "pass" | "fail" | "inconclusive";

export interface TwinExperimentStatus {
  status: TwinExperimentOutcome;
  reasons: [string, ...string[]];
}

interface TwinSampleResultEnvelope {
  schemaVersion: 2;
  experimentId: string;
  sampleId: string;
  snapshotFingerprint: Sha256;
  suiteFingerprint: Sha256;
  policy: TwinExperimentPolicy;
  endpoints: EndpointFingerprint[];
  endpointAssignments: EndpointAssignment[];
  arms: {
    control: TwinArmResult;
    treatment: TwinArmResult;
  };
  caseDeltas: TwinCaseDelta[];
  newlyPassingCaseIds: string[];
  newlyFailingCaseIds: string[];
  regressions: TwinRegression[];
  artifactPaths: TwinExperimentArtifactPaths;
}

export type TwinSampleResult = TwinSampleResultEnvelope & TwinExperimentStatus;

export interface TwinExperimentMetrics {
  requestedSampleCount: number;
  requiredSampleCount: number;
  conclusiveSampleCount: number;
  deterministicDeltas: number[];
  meanDeterministicDelta: number | null;
  treatmentResources: TwinResourceMetrics;
}

interface TwinExperimentResultEnvelope {
  schemaVersion: 2;
  experimentId: string;
  snapshotFingerprint: Sha256;
  suiteFingerprint: Sha256;
  policy: TwinExperimentPolicy;
  endpoints: EndpointFingerprint[];
  samples: TwinSampleResult[];
  metrics: TwinExperimentMetrics;
  artifactPaths: {
    experimentResult: string;
    sampleResults: string[];
  };
}

export type TwinExperimentResult = TwinExperimentResultEnvelope & TwinExperimentStatus;

export function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function assertSha256(value: unknown): asserts value is Sha256 {
  if (!isSha256(value)) throw new Error("expected a lowercase hexadecimal SHA-256 digest");
}

export function isSafeRelativePath(value: unknown): value is SafeRelativePath {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function assertSafeRelativePath(value: unknown): asserts value is SafeRelativePath {
  if (!isSafeRelativePath(value)) throw new Error("expected a safe slash-separated relative path");
}

export function assertTwinExperimentStatus(value: unknown): asserts value is TwinExperimentStatus {
  if (!value || typeof value !== "object") throw new Error("expected a twin experiment status");
  const candidate = value as { status?: unknown; reasons?: unknown };
  if (candidate.status !== "pass" && candidate.status !== "fail" && candidate.status !== "inconclusive") {
    throw new Error("expected experiment status pass, fail, or inconclusive");
  }
  if (
    !Array.isArray(candidate.reasons) ||
    candidate.reasons.length === 0 ||
    !candidate.reasons.every((reason) => typeof reason === "string" && reason.trim().length > 0)
  ) {
    throw new Error("expected at least one experiment status reason");
  }
}

export function assertTwinDecisionCriteria(value: unknown): asserts value is TwinDecisionCriteria {
  if (!value || typeof value !== "object") throw new Error("expected twin decision criteria");
  const candidate = value as Partial<Record<keyof TwinDecisionCriteria, unknown>>;
  const allowedKeys = new Set<keyof TwinDecisionCriteria>([
    "minimumDeterministicLift",
    "protectedLossMargin",
    "maxTreatmentTokens",
    "maxTreatmentModelCalls",
    "maxTreatmentDurationMs",
    "requiredSampleCount",
  ]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key as keyof TwinDecisionCriteria));
  if (unknownKeys.length > 0) throw new Error(`unknown twin decision criteria: ${unknownKeys.sort().join(", ")}`);
  for (const key of [
    "minimumDeterministicLift",
    "protectedLossMargin",
    "maxTreatmentTokens",
    "maxTreatmentModelCalls",
    "maxTreatmentDurationMs",
  ] as const) {
    if (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key]) || candidate[key] < 0) {
      throw new Error(`expected non-negative finite decision criterion: ${key}`);
    }
  }
  for (const key of ["maxTreatmentTokens", "maxTreatmentModelCalls"] as const) {
    if (!Number.isSafeInteger(candidate[key])) {
      throw new Error(`expected integer decision criterion: ${key}`);
    }
  }
  if (!Number.isSafeInteger(candidate.requiredSampleCount) || Number(candidate.requiredSampleCount) < 1) {
    throw new Error("expected positive integer decision criterion: requiredSampleCount");
  }
}
