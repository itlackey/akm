import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { fetchWithRetry, isAssetType, type AgentikitAssetType } from "./common"
import { GITHUB_API_BASE, asRecord, asString, githubHeaders } from "./github"
import { parseRegistryRef } from "./registry-resolve"
import type { RegistryKitEntry } from "./registry-search"
import type { ParsedGithubRef, ParsedNpmRef, ParsedRegistryRef } from "./registry-types"

const REGISTRY_OWNER = "itlackey"
const REGISTRY_REPO = "agentikit-registry"
const MANUAL_ENTRIES_FILE = "manual-entries.json"
const GH_MIN_MAJOR = 2

type SupportedSubmitRef = ParsedNpmRef | ParsedGithubRef

interface PackageJsonLike {
  name?: string
  description?: string
  keywords?: string[]
  homepage?: string
  author?: string
  license?: string
  agentikitAssetTypes?: AgentikitAssetType[]
  repositoryUrl?: string
}

export interface SubmitResponse {
  entry: RegistryKitEntry
  pr?: { url: string; number?: number }
  fork?: { url: string }
  dryRun: boolean
  validation: {
    refAccessible: boolean
    duplicateFound: boolean
  }
  commands?: string[]
}

export interface AgentikitSubmitOptions {
  ref?: string
  name?: string
  description?: string
  tags?: string[] | string
  assetTypes?: string[] | string
  author?: string
  license?: string
  homepage?: string
  dryRun?: boolean
  cleanupFork?: boolean
  cwd?: string
  progress?: (message: string) => void
  ghBin?: string
  gitBin?: string
  interactive?: boolean
}

export async function agentikitSubmit(options: AgentikitSubmitOptions = {}): Promise<SubmitResponse> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const progress = options.progress ?? (() => {})
  const runtime = resolveRuntimeBinaries(options)

  progress("Checking GitHub CLI availability")
  ensureGhAvailable(runtime)

  progress("Checking GitHub CLI authentication")
  ensureGhAuthenticated(runtime)

  progress("Resolving submit target")
  const resolved = await resolveSubmitTarget(options.ref, cwd)

  progress("Building registry entry")
  const entry = await buildSubmitEntry({
    parsed: resolved.parsed,
    packageJson: resolved.packageJson,
    cwd,
    interactive: options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY),
    ...options,
  })

  progress("Validating public accessibility")
  const refAccessible = await isRefAccessible(resolved.parsed)
  if (!refAccessible) {
    throw new Error(`Registry ref "${entry.ref}" is not publicly accessible.`)
  }

  progress("Checking for duplicate manual entries")
  const remoteEntries = await fetchRegistryManualEntries()
  const duplicateFound = remoteEntries.some((item) => asString(asRecord(item).id) === entry.id)
  if (duplicateFound) {
    throw new Error(`Registry entry "${entry.id}" already exists in agentikit-registry.`)
  }

  progress("Looking up GitHub username")
  const username = getGhUsername(runtime)
  const branchName = buildSubmitBranchName(entry.id)
  const commands = buildPlannedCommands({ branchName, entry, username, cleanupFork: options.cleanupFork === true })

  if (options.dryRun) {
    return {
      entry,
      dryRun: true,
      validation: {
        refAccessible,
        duplicateFound,
      },
      commands,
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-submit-"))
  const cloneDir = path.join(tempRoot, REGISTRY_REPO)

  try {
    progress("Forking and cloning agentikit-registry")
    runCommand(runtime, "gh", ["repo", "fork", `${REGISTRY_OWNER}/${REGISTRY_REPO}`, "--clone", "--remote"], { cwd: tempRoot })

    progress(`Creating branch ${branchName}`)
    runCommand(runtime, "git", ["checkout", "-b", branchName], { cwd: cloneDir })

    progress(`Updating ${MANUAL_ENTRIES_FILE}`)
    appendManualEntry(cloneDir, entry)

    progress("Committing manual entry")
    runCommand(runtime, "git", ["add", MANUAL_ENTRIES_FILE], { cwd: cloneDir })
    runCommand(runtime, "git", ["commit", "-m", `feat: add ${entry.name} to registry`], { cwd: cloneDir })

    progress("Pushing branch to fork")
    runCommand(runtime, "git", ["push", "origin", branchName], { cwd: cloneDir })

    progress("Opening pull request")
    const pr = createPullRequest({ cloneDir, username, branchName, entry, runtime })

    if (options.cleanupFork) {
      progress("Deleting temporary fork")
      runCommand(runtime, "gh", ["repo", "delete", `${username}/${REGISTRY_REPO}`, "--yes"], { cwd: cloneDir })
    }

    return {
      entry,
      pr,
      fork: { url: `https://github.com/${username}/${REGISTRY_REPO}` },
      dryRun: false,
      validation: {
        refAccessible,
        duplicateFound,
      },
      commands,
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

export async function buildSubmitEntry(
  options: AgentikitSubmitOptions & {
    parsed: SupportedSubmitRef
    packageJson?: PackageJsonLike
    interactive?: boolean
  },
): Promise<RegistryKitEntry> {
  const packageJson = options.packageJson
  const interactive = options.interactive === true

  const defaultName = options.name?.trim()
    || packageJson?.name
    || inferNameFromParsedRef(options.parsed)
  const defaultDescription = options.description?.trim()
    || packageJson?.description
  const defaultTags = normalizeTags(options.tags ?? packageJson?.keywords ?? [])
  const defaultAssetTypes = normalizeAssetTypes(options.assetTypes ?? packageJson?.agentikitAssetTypes ?? [])
  const defaultAuthor = options.author?.trim()
    || packageJson?.author
  const defaultLicense = options.license?.trim()
    || packageJson?.license
  const defaultHomepage = options.homepage?.trim()
    || packageJson?.homepage
    || inferHomepage(options.parsed)

  const promptedName = await promptWithDefault("Name", defaultName, interactive)
  const promptedDescription = await promptWithDefault("Description", defaultDescription, interactive)
  const promptedTags = await promptWithDefault("Tags (comma-separated)", defaultTags.join(", "), interactive)
  const promptedAssetTypes = await promptWithDefault("Asset types (comma-separated)", defaultAssetTypes.join(", "), interactive)
  const promptedAuthor = await promptWithDefault("Author", defaultAuthor, interactive)
  const promptedLicense = await promptWithDefault("License", defaultLicense, interactive)
  const promptedHomepage = await promptWithDefault("Homepage", defaultHomepage, interactive)

  const name = promptedName?.trim() || defaultName
  if (!name) {
    throw new Error("Unable to determine a name for the registry entry.")
  }

  const description = promptedDescription?.trim() || defaultDescription
  const tags = normalizeTags(promptedTags || defaultTags)
  const assetTypes = normalizeAssetTypes(promptedAssetTypes || defaultAssetTypes)
  const author = promptedAuthor?.trim() || defaultAuthor?.trim()
  const license = promptedLicense?.trim() || defaultLicense?.trim()
  const homepage = promptedHomepage?.trim() || defaultHomepage?.trim()

  const entry: RegistryKitEntry = {
    id: options.parsed.id,
    name,
    ref: canonicalSubmitRef(options.parsed),
    source: options.parsed.source,
  }

  if (description) entry.description = description
  if (homepage) entry.homepage = homepage
  if (tags.length > 0) entry.tags = tags
  if (assetTypes.length > 0) entry.assetTypes = assetTypes
  if (author) entry.author = author
  if (license) entry.license = license

  return entry
}

export function buildSubmitBranchName(entryId: string, now = new Date()): string {
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(now.getUTCDate()).padStart(2, "0")
  const hh = String(now.getUTCHours()).padStart(2, "0")
  const min = String(now.getUTCMinutes()).padStart(2, "0")
  return `submit/${slugifySubmitValue(entryId)}-${yyyy}${mm}${dd}-${hh}${min}`
}

export function slugifySubmitValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
}

async function resolveSubmitTarget(rawRef: string | undefined, cwd: string): Promise<{
  parsed: SupportedSubmitRef
  packageJson?: PackageJsonLike
}> {
  if (!rawRef) {
    return await inferSubmitTargetFromDir(cwd)
  }

  const parsed = parseSubmitRef(rawRef)
  if (parsed.source === "npm" || parsed.source === "github") {
    return { parsed }
  }
  if (parsed.source === "local") {
    return await inferSubmitTargetFromDir(parsed.sourcePath)
  }

  throw new Error("`akm submit` requires a public npm package or GitHub repository ref.")
}

async function inferSubmitTargetFromDir(dir: string): Promise<{
  parsed: SupportedSubmitRef
  packageJson?: PackageJsonLike
}> {
  const packageJson = readPackageJson(dir)
  if (!packageJson) {
    throw new Error("Unable to infer a public npm or GitHub ref from the current directory. Add a package.json or pass a ref explicitly.")
  }

  const candidates: SupportedSubmitRef[] = []
  if (packageJson.name) {
    candidates.push(parseSubmitRef(packageJson.name) as ParsedNpmRef)
  }
  const githubRef = extractGithubRepoRef(packageJson.repositoryUrl)
    ?? extractGithubRepoRef(packageJson.homepage)
  if (githubRef) {
    candidates.push(parseSubmitRef(githubRef) as ParsedGithubRef)
  }

  for (const candidate of candidates) {
    if (await isRefAccessible(candidate)) {
      return { parsed: candidate, packageJson }
    }
  }

  throw new Error("Unable to infer a publicly accessible npm package or GitHub repository from package.json.")
}

function readPackageJson(dir: string): PackageJsonLike | undefined {
  const packagePath = path.join(dir, "package.json")
  if (!fs.existsSync(packagePath)) return undefined

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(packagePath, "utf8"))
  } catch {
    throw new Error(`Failed to parse package.json in ${dir}.`)
  }
  const pkg = asRecord(raw)
  const repository = normalizeRepositoryUrl(pkg.repository)
  const author = normalizeAuthor(pkg.author)
  const keywords = Array.isArray(pkg.keywords)
    ? pkg.keywords.filter((value): value is string => typeof value === "string")
    : undefined
  const agentikit = asRecord(pkg.agentikit)
  const assetTypes = Array.isArray(agentikit.assetTypes)
    ? agentikit.assetTypes.filter((value): value is AgentikitAssetType => typeof value === "string" && isAssetType(value))
    : undefined

  return {
    name: asString(pkg.name),
    description: asString(pkg.description),
    keywords,
    homepage: asString(pkg.homepage),
    author,
    license: asString(pkg.license),
    agentikitAssetTypes: assetTypes,
    repositoryUrl: repository,
  }
}

function normalizeRepositoryUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    return asString((value as Record<string, unknown>).url)
  }
  return undefined
}

function normalizeAuthor(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    return asString((value as Record<string, unknown>).name)
  }
  return undefined
}

function inferNameFromParsedRef(parsed: SupportedSubmitRef): string {
  if (parsed.source === "npm") return parsed.packageName
  return parsed.repo
}

function canonicalSubmitRef(parsed: SupportedSubmitRef): string {
  if (parsed.source === "npm") return parsed.packageName
  return parsed.requestedRef ? `${parsed.owner}/${parsed.repo}#${parsed.requestedRef}` : `${parsed.owner}/${parsed.repo}`
}

function inferHomepage(parsed: SupportedSubmitRef): string {
  if (parsed.source === "npm") {
    return `https://www.npmjs.com/package/${encodeURIComponent(parsed.packageName)}`
  }
  return `https://github.com/${parsed.owner}/${parsed.repo}`
}

function extractGithubRepoRef(value: string | undefined): string | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/^git\+/, "")
  const httpsMatch = cleaned.match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/i)
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`
  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/([^/#]+?)(?:\.git)?$/i)
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`
  const shortMatch = cleaned.match(/^github:([^/]+)\/([^/#]+?)(?:#.*)?$/i)
  if (shortMatch) return `${shortMatch[1]}/${shortMatch[2]}`
  return undefined
}

function parseSubmitRef(rawRef: string): ParsedNpmRef | ParsedGithubRef | ParsedRegistryRef {
  const trimmed = rawRef.trim()
  if (looksLikeScopedPackage(trimmed)) {
    return parseRegistryRef(`npm:${trimmed}`)
  }
  if (looksLikeGithubRepo(trimmed)) {
    return parseRegistryRef(`github:${trimmed}`)
  }
  return parseRegistryRef(trimmed)
}

function looksLikeScopedPackage(value: string): boolean {
  return /^@[^/]+\/[^/@]+(?:@[^/]+)?$/.test(value)
}

function looksLikeGithubRepo(value: string): boolean {
  return /^[^./][^/]*\/[^/]+(?:#.+)?$/.test(value)
}

async function promptWithDefault(label: string, value: string | undefined, interactive: boolean): Promise<string | undefined> {
  if (!interactive) return value
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = value ? ` [${value}]` : ""
    const answer = await rl.question(`${label}${suffix}: `)
    return answer.trim() || value
  } finally {
    rl.close()
  }
}

function normalizeTags(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []
  const deduped = new Set<string>()
  for (const item of values) {
    const normalized = item.trim().toLowerCase()
    if (!normalized || normalized === "agentikit" || normalized === "akm") continue
    deduped.add(normalized)
  }
  return Array.from(deduped)
}

function normalizeAssetTypes(value: string | string[] | undefined): AgentikitAssetType[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []
  const deduped = new Set<AgentikitAssetType>()
  for (const item of values) {
    const normalized = item.trim().toLowerCase()
    if (!normalized) continue
    if (!isAssetType(normalized)) {
      throw new Error(`Invalid asset type: ${item}`)
    }
    deduped.add(normalized)
  }
  return Array.from(deduped)
}

async function isRefAccessible(parsed: SupportedSubmitRef): Promise<boolean> {
  if (parsed.source === "npm") {
    const url = `https://registry.npmjs.org/${encodeURIComponent(parsed.packageName)}`
    const response = await fetchWithRetry(url, undefined, { timeout: 10_000 })
    return response.ok
  }

  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
  const response = await fetchWithRetry(url, { headers: githubHeaders() }, { timeout: 10_000 })
  return response.ok
}

async function fetchRegistryManualEntries(): Promise<unknown[]> {
  const repoResponse = await fetchWithRetry(
    `${GITHUB_API_BASE}/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}`,
    { headers: githubHeaders() },
    { timeout: 10_000 },
  )
  if (!repoResponse.ok) {
    throw new Error(`Failed to load ${REGISTRY_OWNER}/${REGISTRY_REPO} metadata (${repoResponse.status}).`)
  }
  const repoJson = asRecord(await repoResponse.json())
  const defaultBranch = asString(repoJson.default_branch) ?? "main"

  const rawUrl = `https://raw.githubusercontent.com/${REGISTRY_OWNER}/${REGISTRY_REPO}/${encodeURIComponent(defaultBranch)}/${MANUAL_ENTRIES_FILE}`
  const entriesResponse = await fetchWithRetry(rawUrl, undefined, { timeout: 10_000 })
  if (!entriesResponse.ok) {
    throw new Error(`Failed to load ${MANUAL_ENTRIES_FILE} from ${REGISTRY_OWNER}/${REGISTRY_REPO} (${entriesResponse.status}).`)
  }

  const parsed = await entriesResponse.json() as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`${MANUAL_ENTRIES_FILE} is not a JSON array.`)
  }
  return parsed
}

function appendManualEntry(cloneDir: string, entry: RegistryKitEntry): void {
  const filePath = path.join(cloneDir, MANUAL_ENTRIES_FILE)
  const existing = readManualEntriesFile(filePath)
  existing.push(entry)
  fs.writeFileSync(filePath, `${JSON.stringify(existing, null, 2)}\n`, "utf8")
}

function readManualEntriesFile(filePath: string): unknown[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown
  if (!Array.isArray(raw)) {
    throw new Error(`${MANUAL_ENTRIES_FILE} in the fork is not a JSON array.`)
  }
  return raw
}

function createPullRequest(options: {
  cloneDir: string
  username: string
  branchName: string
  entry: RegistryKitEntry
  runtime: SubmitRuntime
}): { url: string; number?: number } {
  const body = buildPullRequestBody(options.entry)
  const output = runCommand(
    options.runtime,
    "gh",
    [
      "pr",
      "create",
      "--repo",
      `${REGISTRY_OWNER}/${REGISTRY_REPO}`,
      "--title",
      `Add ${options.entry.name} to registry`,
      "--body",
      body,
      "--head",
      `${options.username}:${options.branchName}`,
    ],
    { cwd: options.cloneDir },
  )

  const url = output.stdout.trim().split(/\r?\n/).find((line) => /^https:\/\/github\.com\//.test(line))
  if (!url) {
    throw new Error("gh pr create did not return a pull request URL.")
  }
  const match = url.match(/\/pull\/(\d+)(?:\/?$)/)
  return {
    url,
    number: match ? parseInt(match[1], 10) : undefined,
  }
}

function buildPullRequestBody(entry: RegistryKitEntry): string {
  return [
    `## New registry entry: ${entry.name}`,
    "",
    `**Ref:** \`${entry.ref}\` (${entry.source})`,
    `**Install:** \`akm add ${entry.ref}\``,
    "",
    "### Entry JSON",
    "```json",
    JSON.stringify(entry, null, 2),
    "```",
    "",
    "### Verification",
    "- [ ] Ref is publicly accessible",
    "- [ ] Package/repo contains agentikit-compatible assets",
    "",
    "Submitted via `akm submit`",
  ].join("\n")
}

function buildPlannedCommands(options: {
  branchName: string
  entry: RegistryKitEntry
  username: string
  cleanupFork: boolean
}): string[] {
  const commands = [
    `gh repo fork ${REGISTRY_OWNER}/${REGISTRY_REPO} --clone --remote`,
    `git checkout -b ${options.branchName}`,
    `git add ${MANUAL_ENTRIES_FILE}`,
    `git commit -m "feat: add ${options.entry.name} to registry"`,
    `git push origin ${options.branchName}`,
    `gh pr create --repo ${REGISTRY_OWNER}/${REGISTRY_REPO} --title "Add ${options.entry.name} to registry" --head ${options.username}:${options.branchName}`,
  ]
  if (options.cleanupFork) {
    commands.push(`gh repo delete ${options.username}/${REGISTRY_REPO} --yes`)
  }
  return commands
}

function ensureGhAvailable(runtime: SubmitRuntime): void {
  const result = spawnSync(runtime.ghBin, ["--version"], { encoding: "utf8", timeout: 10_000 })
  if (result.error || result.status !== 0) {
    throw new Error("gh CLI is required to use `akm submit`.")
  }

  const versionText = `${result.stdout}\n${result.stderr}`
  const match = versionText.match(/gh version (\d+)\.(\d+)\.(\d+)/i)
  if (!match) return
  const major = parseInt(match[1], 10)
  if (major < GH_MIN_MAJOR) {
    throw new Error("gh CLI is required to use `akm submit`.")
  }
}

function ensureGhAuthenticated(runtime: SubmitRuntime): void {
  const result = spawnSync(runtime.ghBin, ["auth", "status", "--hostname", "github.com"], { encoding: "utf8", timeout: 10_000 })
  if (result.status !== 0) {
    throw new Error("gh CLI is not authenticated for github.com.")
  }
}

function getGhUsername(runtime: SubmitRuntime): string {
  const result = runCommand(runtime, "gh", ["api", "user", "--jq", ".login"])
  const username = result.stdout.trim()
  if (!username) {
    throw new Error("Unable to determine GitHub username from gh CLI.")
  }
  return username
}

interface SubmitRuntime {
  ghBin: string
  gitBin: string
}

function resolveRuntimeBinaries(options: AgentikitSubmitOptions): SubmitRuntime {
  return {
    ghBin: options.ghBin?.trim() || process.env.AKM_SUBMIT_GH_BIN?.trim() || "gh",
    gitBin: options.gitBin?.trim() || process.env.AKM_SUBMIT_GIT_BIN?.trim() || "git",
  }
}

function runCommand(
  runtime: SubmitRuntime,
  command: string,
  args: string[],
  options?: Omit<SpawnSyncOptionsWithStringEncoding, "encoding">,
): { stdout: string; stderr: string; status: number | null; error?: Error } {
  const result = spawnSync(resolveCommandBin(runtime, command), args, {
    ...options,
    encoding: "utf8",
    timeout: options?.timeout ?? 120_000,
  })

  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || "unknown error"
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${detail}`)
  }

  return result
}

function resolveCommandBin(runtime: SubmitRuntime, command: "gh" | "git" | string): string {
  if (command === "gh") return runtime.ghBin
  if (command === "git") return runtime.gitBin
  return command
}
