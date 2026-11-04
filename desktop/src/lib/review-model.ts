import type { Proposal, ProposalQueue } from './types';

export interface ReviewQueue extends ProposalQueue {
  fullCount?: number;
  backlog?: Array<{ source: string; underDay: number; underWeek: number; older: number; unknown: number }>;
}
export interface ReviewProposal extends Proposal {
  createdAt?: string;
  sourceRun?: string;
  decider?: string | null;
  gateDecision?: { outcome: string; reason?: string } | null;
  proposedTarget?: { source: string; root: string } | null;
}
export const ageBands = { underDay: 'Under 1 day', underWeek: '1–7 days', older: '7+ days', unknown: 'No recorded age' };
export const rejectionChoices = ['Wrong', 'Stale', 'Duplicate', 'Style', 'Other'];
/** A concept's canonical parent, not a claim about its physical filesystem path. */
export function conceptLocation(ref: string): string {
  const bundle = ref.indexOf('//'), last = ref.lastIndexOf('/');
  return last > bundle + 1 ? ref.slice(0, last) : bundle >= 0 ? ref.slice(0, bundle + 2) : ref;
}
export function rejectionReason(choice: string, details: string): string {
  return [choice, details.trim()].filter(Boolean).join(': ');
}
export function rejectionError(choice: string, details: string): string {
  if (!details.trim() && (!choice || choice === 'Other')) return 'Choose a reason or write details. Details are required for Other.';
  if (rejectionReason(choice, details).length > 2000) return 'The combined rejection reason must be at most 2000 characters.';
  return '';
}
export function proposalId(route: string, query: URLSearchParams): string {
  const encoded = route.replace(/^\/?proposals\/?/, '');
  try { return encoded ? decodeURIComponent(encoded) : query.get('id') ?? ''; }
  catch { return ''; }
}
export function proposalHref(id: string, query: URLSearchParams): string {
  const params = new URLSearchParams(query);
  params.delete('id');
  return `#/proposals${id ? `/${encodeURIComponent(id)}` : ''}${params.size ? `?${params}` : ''}`;
}
/** Only in-app analytics locations can be an analytics return destination. */
export function activityReturn(value: string | null): string | null {
  return value && /^#\/(?:improve|overview)(?:\?|$)/.test(value) ? value : null;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export function text(value: unknown, fallback = 'Not recorded'): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}
export function commitOutcome(value: unknown): string {
  const commit = record(value);
  return typeof commit.sha === 'string'
    ? `Committed ${commit.sha.slice(0, 8)}${commit.subject ? ` — ${commit.subject}` : ''}. Push status was not reported by this action.`
    : 'No Git commit was reported by this action.';
}
