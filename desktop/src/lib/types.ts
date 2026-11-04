export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export interface AssetSummary {
  ref: string;
  name?: string;
  title?: string;
  description?: string;
  type?: string;
  origin?: string;
  metadata?: Record<string, Json>;
  frontmatter?: Record<string, Json>;
}
export interface Asset extends AssetSummary {
  content?: string;
  template?: string;
  prompt?: string;
  path?: string;
  editable?: boolean;
  links?: Json;
}
export interface AssetDetail {
  redacted: boolean;
  note?: string;
  durableRef?: string;
  bundle?: string;
  asset: Asset;
  feedback?: Json;
  feedbackRequireReason?: boolean;
  links?: Record<string, string>;
}
export interface Bundle {
  name: string;
  enabled: boolean;
  writable: boolean;
  default?: boolean;
  source?: { kind: string; locator: string };
  path?: string;
  kind: string;
  itemCount?: number;
  byType?: Record<string, number>;
  components: Array<{ adapter: string; [key: string]: Json | undefined }>;
  git?: Json;
  settingsSource?: string;
}
export interface Source {
  ref?: string;
  revision: string;
  content: string;
  type?: string;
  markdown?: boolean /** False in a bundle akm does not write to (an installed one): view only. */;
  writable?: boolean;
}
export interface TextDiff {
  before: string | null;
  after: string | null;
  unified?: string;
  truncated?: boolean;
  redacted?: boolean;
  isNew?: boolean;
}
export interface Commit {
  sha: string;
  time: string;
  subject: string;
  paths?: string[];
  pathCount?: number;
  author?: string;
  origin?: string;
}
export interface History {
  available: boolean;
  commits: Commit[];
  diff?: TextDiff;
}
export interface Proposal extends AssetSummary {
  id: string;
  source: string;
  status: string;
  waitingSince?: string;
  updatedAt?: string;
  isRetire?: boolean;
  revertable?: boolean;
  reason?: string;
  review?: Json;
  changes?: Json;
  confidence?: number;
  retirement?: Json;
}
export interface ProposalDetail {
  proposal: Proposal;
  diff?: TextDiff;
  diffError?: string;
  validation?: Json;
}
export interface ProposalQueue {
  proposals: Proposal[];
  totalCount: number;
  bySource: Record<string, number>;
}
export interface WriteResult {
  ref?: string;
  unchanged?: boolean;
  accepted?: number;
  rejected?: number;
  failed?: number;
  results?: Array<{ id: string; ref?: string; ok: boolean; error?: string; code?: string }>;
  [key: string]: unknown;
}
export interface Configuration {
  path: string;
  entries: Array<{ path: string; value: Json; source: string | null }>;
  [key: string]: unknown;
}
