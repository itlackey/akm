// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text renderers for `akm proposal *` and `akm distill` commands.
 *
 * Split out of `helpers.ts` (formerly 1418 lines / 59 fns) as its own
 * sibling module: proposal listing/show share the gate-decision summary
 * helpers, and distill is the producer of proposals, so the cluster stays
 * together.
 */

export function formatProposalProducerPlain(command: string, r: Record<string, unknown>): string {
  if (r.ok === false) {
    const reason = String(r.reason ?? "unknown");
    const error = typeof r.error === "string" ? r.error : "";
    const lines = [`${command}: failed (${reason})`];
    if (error) lines.push(`  error: ${error}`);
    if (r.ref) lines.push(`  ref: ${String(r.ref)}`);
    if (r.exitCode !== undefined && r.exitCode !== null) {
      lines.push(`  exitCode: ${String(r.exitCode)}`);
    }
    return lines.join("\n");
  }
  const proposal = (r.proposal as Record<string, unknown>) ?? {};
  const id = String(proposal.id ?? "?");
  const ref = String(r.ref ?? proposal.ref ?? "?");
  const status = String(proposal.status ?? "pending");
  return `${command}: queued proposal ${id} (${ref}) [${status}]`;
}

/**
 * Render a one-line gate-decision summary for the proposal list / show surfaces
 * (#577), e.g. `gate=deferred:below-threshold (0.72 < 0.90)`. Returns the empty
 * string for a missing or malformed decision so legacy proposals render cleanly.
 */
export function formatGateDecisionSummary(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "";
  const d = raw as Record<string, unknown>;
  const outcome = typeof d.outcome === "string" ? d.outcome : undefined;
  if (!outcome) return "";
  const reason = typeof d.reason === "string" && d.reason.length > 0 ? `:${d.reason}` : "";
  const cmp = formatGateThresholdComparison(d);
  return `gate=${outcome}${reason}${cmp ? ` (${cmp})` : ""}`;
}

/**
 * Reconstruct the threshold comparison the gate applied, when both sides are
 * present (e.g. confidence 0.72 vs. autoAccept 0.90 → "0.72 < 0.90"). Returns
 * the empty string when the decision lacks the operands.
 */
function formatGateThresholdComparison(d: Record<string, unknown>): string {
  const thresholds = (typeof d.thresholds === "object" && d.thresholds !== null ? d.thresholds : {}) as Record<
    string,
    unknown
  >;
  const confidence = typeof d.confidence === "number" ? d.confidence : undefined;
  const autoAccept = typeof thresholds.autoAccept === "number" ? thresholds.autoAccept : undefined;
  if (confidence !== undefined && autoAccept !== undefined) {
    const op = confidence >= autoAccept ? ">=" : "<";
    return `${confidence.toFixed(2)} ${op} ${autoAccept.toFixed(2)}`;
  }
  // Drain bands: when the measured value is present, render the full comparison
  // ("210 > 200" / "1 < 5"); otherwise fall back to the bound alone (#577).
  const measured = typeof d.measured === "number" ? d.measured : undefined;
  if (typeof thresholds.maxDiffLines === "number") {
    return measured !== undefined
      ? `${measured} > ${thresholds.maxDiffLines}`
      : `maxDiffLines=${thresholds.maxDiffLines}`;
  }
  if (typeof thresholds.minContentLines === "number") {
    return measured !== undefined
      ? `${measured} < ${thresholds.minContentLines}`
      : `minContentLines=${thresholds.minContentLines}`;
  }
  return "";
}

export function formatProposalListPlain(r: Record<string, unknown>): string {
  const proposals = Array.isArray(r.proposals) ? (r.proposals as Array<Record<string, unknown>>) : [];
  const total = typeof r.totalCount === "number" ? r.totalCount : proposals.length;
  if (proposals.length === 0) {
    return `${total} proposal(s).\nNo proposals.\nGenerate one with \`akm reflect <ref>\`, \`akm propose <type> <name> --task ...\`, or \`akm distill <ref>\`.`;
  }
  const lines = [`${total} proposal(s)`, ""];
  for (const p of proposals) {
    const id = String(p.id ?? "?");
    const ref = String(p.ref ?? "?");
    const status = String(p.status ?? "?");
    const source = String(p.source ?? "?");
    const created = String(p.createdAt ?? "?");
    // #577: surface the gate verdict inline so the queue explains itself
    // ("deferred: below-threshold"). Legacy proposals carry no gateDecision.
    const gate = formatGateDecisionSummary(p.gateDecision);
    const gateSuffix = gate ? `  ${gate}` : "";
    lines.push(`${id}  [${status}] ${ref}  source=${source}  ${created}${gateSuffix}`);
  }
  return lines.join("\n").trimEnd();
}

export function formatProposalShowPlain(r: Record<string, unknown>): string {
  const p = (r.proposal as Record<string, unknown>) ?? {};
  const lines: string[] = [];
  lines.push(`# proposal ${String(p.id ?? "?")}`);
  lines.push(`ref: ${String(p.ref ?? "?")}`);
  lines.push(`status: ${String(p.status ?? "?")}`);
  lines.push(`source: ${String(p.source ?? "?")}`);
  if (p.sourceRun) lines.push(`sourceRun: ${String(p.sourceRun)}`);
  if (p.createdAt) lines.push(`createdAt: ${String(p.createdAt)}`);
  if (p.updatedAt) lines.push(`updatedAt: ${String(p.updatedAt)}`);
  if (typeof p.confidence === "number") lines.push(`confidence: ${p.confidence.toFixed(2)}`);
  // #577: gate decision (auto-accepted / deferred / auto-rejected + reason +
  // thresholds). Absent on legacy proposals — render "unknown" so the field is
  // always present and the operator never sees a silent gap.
  const gate = p.gateDecision as Record<string, unknown> | undefined;
  if (gate && typeof gate.outcome === "string") {
    lines.push(`gate.decision: ${String(gate.outcome)}`);
    lines.push(`gate.reason: ${gate.reason ? String(gate.reason) : "unknown"}`);
    const cmp = formatGateThresholdComparison(gate);
    if (cmp) lines.push(`gate.thresholds: ${cmp}`);
    if (gate.gate) lines.push(`gate.by: ${String(gate.gate)}`);
    if (gate.decidedAt) lines.push(`gate.decidedAt: ${String(gate.decidedAt)}`);
  } else {
    lines.push("gate.decision: unknown");
  }
  const review = p.review as Record<string, unknown> | undefined;
  if (review) {
    lines.push(`review.outcome: ${String(review.outcome ?? "?")}`);
    if (review.reason) lines.push(`review.reason: ${String(review.reason)}`);
    if (review.decidedAt) lines.push(`review.decidedAt: ${String(review.decidedAt)}`);
  }
  const validation = r.validation as Record<string, unknown> | undefined;
  if (validation) {
    const findings = Array.isArray(validation.findings) ? (validation.findings as Array<Record<string, unknown>>) : [];
    // Partition findings by severity. `severity: "warn"` findings are
    // non-blocking (the validator reports `ok: true` for a warn-only proposal),
    // so they must read as advisory — a distinct icon/label from blocking errors.
    const warnings = findings.filter((f) => f.severity === "warn");
    const errors = findings.filter((f) => f.severity !== "warn");
    lines.push("");
    if (errors.length > 0) {
      const warnSuffix = warnings.length > 0 ? `, ${warnings.length} warning(s)` : "";
      lines.push(`✗ invalid (${errors.length} error(s)${warnSuffix})`);
    } else if (warnings.length > 0) {
      lines.push(`✓ valid (${warnings.length} warning(s))`);
    } else {
      lines.push("✓ valid");
    }
    // Errors first (blocking), then warnings (advisory, non-blocking).
    for (const f of errors) {
      lines.push(`  ✗ error  [${String(f.kind)}] ${String(f.message)}`);
    }
    for (const f of warnings) {
      lines.push(`  ⚠ warning  [${String(f.kind)}] ${String(f.message)} (non-blocking)`);
    }
  }
  const payload = p.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.content === "string") {
    lines.push("");
    lines.push("payload:");
    lines.push(payload.content);
  }
  return lines.join("\n").trimEnd();
}

export function formatProposalAcceptPlain(r: Record<string, unknown>): string {
  return `Accepted proposal ${String(r.id ?? "?")} → ${String(r.ref ?? "?")} at ${String(r.assetPath ?? "?")}`;
}

export function formatProposalRejectPlain(r: Record<string, unknown>): string {
  const reason = r.reason ? ` (${String(r.reason)})` : "";
  return `Rejected proposal ${String(r.id ?? "?")} (${String(r.ref ?? "?")})${reason}`;
}

export function formatProposalDrainPlain(r: Record<string, unknown>): string {
  const policy = String(r.policy ?? "?");
  const applyMode = String(r.applyMode ?? "queue");
  const promoted = Array.isArray(r.promoted) ? (r.promoted as unknown[]) : [];
  const rejected = Array.isArray(r.rejected) ? (r.rejected as unknown[]) : [];
  const deferred = Array.isArray(r.deferred) ? (r.deferred as Array<Record<string, unknown>>) : [];
  const skippedByCap = Array.isArray(r.skippedByCap) ? (r.skippedByCap as unknown[]) : [];
  const staged = Array.isArray(r.staged) ? (r.staged as unknown[]) : [];
  const prefix = r.dryRun === true ? "[dry-run] " : "";
  const lines = [
    `${prefix}Drained proposal queue (strategy=${String(r.strategy ?? "?")}, policy=${policy}, applyMode=${applyMode})`,
    `  promoted: ${promoted.length}`,
    `  rejected: ${rejected.length}`,
    `  deferred: ${deferred.length}`,
    `  skippedByCap: ${skippedByCap.length}`,
    `  staged: ${staged.length}`,
  ];
  for (const d of deferred) {
    lines.push(`    - ${String(d.id ?? "?")} (${String(d.reason ?? "?")})`);
  }
  return lines.join("\n").trimEnd();
}

export function formatDistillPlain(r: Record<string, unknown>): string {
  const outcome = String(r.outcome ?? "unknown");
  const inputRef = String(r.inputRef ?? "?");
  const lessonRef = String(r.lessonRef ?? "?");
  if (outcome === "queued") {
    const id = String(r.proposalId ?? "?");
    return `Distilled ${inputRef} → proposal ${id} (${lessonRef}). Run \`akm proposal show ${id}\` to review.`;
  }
  if (outcome === "validation_failed") {
    const findings = Array.isArray(r.findings) ? (r.findings as Array<Record<string, unknown>>) : [];
    const lines = [`Distillation produced an invalid lesson for ${inputRef}; no proposal queued.`];
    for (const f of findings) {
      lines.push(`  - ${String(f.message ?? f.kind ?? "validation finding")}`);
    }
    return lines.join("\n");
  }
  // skipped
  const message = typeof r.message === "string" ? r.message : "feature disabled or LLM unavailable";
  return `Distill skipped for ${inputRef}: ${message}`;
}

export function formatProposalDiffPlain(r: Record<string, unknown>): string {
  const header = r.isNew
    ? `# proposal ${String(r.id ?? "?")} (new asset: ${String(r.ref ?? "?")})`
    : `# proposal ${String(r.id ?? "?")} (update: ${String(r.ref ?? "?")})`;
  const unified = typeof r.unified === "string" ? r.unified : "";
  if (!unified) return `${header}\n(no changes)`;
  return `${header}\n${unified}`;
}
