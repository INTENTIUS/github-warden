/**
 * Compliance reporting (aggregator).
 *
 * Produces a unified posture snapshot across ALL cycles plus the audit engine.
 * Unlike a reconcile cycle, this does NOT touch GitHub — it is a pure,
 * detect-and-report pass over the STRUCTURED RESULTS the other cycles already
 * produced (`ReconcileResult` from `reconcile/runner.ts`) and, optionally, the
 * audit report (`PostureReport` from `audit/engine.ts`).
 *
 * The output is rendered for stdout / a check-run summary
 * (`renderComplianceReport`) and serialized as a committable JSON artifact
 * (`complianceArtifact`).
 *
 * Pure and deterministic: no I/O, no clock. The caller stamps `generatedAt`.
 */

import type { ReconcileResult } from "../reconcile/runner.js";
import type { PostureReport } from "../audit/engine.js";
import type { IdentityReport } from "./identity.js";
import { renderIdentityReport } from "./identity.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-cycle (per-org) compliance line. */
export interface CycleComplianceEntry {
  cycle: string;
  org: string;
  /** Change-set counts (drift detected). */
  drift: { create: number; update: number; delete: number; total: number };
  /** Guardrail status for this cycle's apply. */
  guardrails: { ok: boolean; blocked: boolean; tripped: string[] };
  /** Entries applied (apply mode only). */
  applied: number;
  /** Entries that failed to apply. */
  failed: number;
}

/** Aggregated audit totals (carried through from the audit engine). */
export interface AuditCompliance {
  total: number;
  quickWin: number;
  needsReview: number;
  reportOnly: number;
  /** Quick-win + needs-review (the "merge-worthy" tier). */
  mergeWorthy: number;
}

/** A cycle that errored during fetchLive/buildDesired. */
export interface ComplianceError {
  cycle: string;
  org: string;
  stage: string;
  error: string;
}

/** The unified compliance snapshot. */
export interface ComplianceReport {
  /** ISO timestamp, stamped by the caller (the aggregator is clock-free). */
  generatedAt?: string;
  /** Distinct run modes observed across the inputs. */
  modes: Array<"dry-run" | "apply">;
  /** Per-cycle compliance lines. */
  cycles: CycleComplianceEntry[];
  /** Audit totals, when an audit report was supplied. */
  audit?: AuditCompliance;
  /** Identity & service-account hygiene, when an identity pass was run. */
  identity?: IdentityReport;
  /** Cross-cutting roll-ups. */
  totals: {
    /** Total change-set entries across all cycles (total drift). */
    drift: number;
    /** Cycles whose guardrails tripped. */
    guardrailTrips: number;
    /** Cycles whose apply was blocked by guardrails. */
    guardrailBlocked: number;
    /** Entries applied across all cycles. */
    applied: number;
    /** Entries that failed to apply across all cycles. */
    failed: number;
    /** Number of cycle/org results aggregated. */
    cyclesReporting: number;
    /** Audit merge-worthy findings (0 when no audit supplied). */
    auditMergeWorthy: number;
  };
  /** Cycles that errored (fetchLive/buildDesired). */
  errored: ComplianceError[];
  /** Cycles deferred due to budget exhaustion (by "<cycle>@<org>"). */
  deferred: string[];
  /**
   * True when nothing needs attention: no drift, no guardrail trips, no
   * failures, no errors, no deferrals, and no merge-worthy audit findings.
   */
  clean: boolean;
}

// ---------------------------------------------------------------------------
// buildComplianceReport
// ---------------------------------------------------------------------------

/**
 * Aggregate one or more reconcile results (and an optional audit report) into a
 * single compliance snapshot. Pass the results from each `runReconcile` call
 * (e.g. one per cycle group, or a single all-cycles run).
 */
export function buildComplianceReport(
  results: ReconcileResult[],
  audit?: PostureReport,
  identity?: IdentityReport,
): ComplianceReport {
  const cycles: CycleComplianceEntry[] = [];
  const errored: ComplianceError[] = [];
  const deferred: string[] = [];
  const modeSet = new Set<"dry-run" | "apply">();

  let drift = 0;
  let guardrailTrips = 0;
  let guardrailBlocked = 0;
  let applied = 0;
  let failed = 0;

  for (const result of results) {
    modeSet.add(result.mode);

    for (const cr of result.cycles) {
      const total = cr.counts.create + cr.counts.update + cr.counts.delete;
      const tripped = cr.guardrails.ok ? [] : cr.guardrails.diagnostics.map((d) => d.guardrail);

      cycles.push({
        cycle: cr.name,
        org: cr.org,
        drift: { ...cr.counts, total },
        guardrails: { ok: cr.guardrails.ok, blocked: cr.guardrailBlocked, tripped },
        applied: cr.applied.length,
        failed: cr.failed.length,
      });

      drift += total;
      if (!cr.guardrails.ok) guardrailTrips++;
      if (cr.guardrailBlocked) guardrailBlocked++;
      applied += cr.applied.length;
      failed += cr.failed.length;
    }

    for (const ce of result.errored) {
      errored.push({ cycle: ce.name, org: ce.org, stage: ce.stage, error: ce.error });
    }
    deferred.push(...result.deferred.skippedCycles);
  }

  let auditCompliance: AuditCompliance | undefined;
  let auditMergeWorthy = 0;
  if (audit) {
    auditMergeWorthy = audit.totals.quickWin + audit.totals.needsReview;
    auditCompliance = {
      total: audit.totals.total,
      quickWin: audit.totals.quickWin,
      needsReview: audit.totals.needsReview,
      reportOnly: audit.totals.reportOnly,
      mergeWorthy: auditMergeWorthy,
    };
  }

  const clean =
    drift === 0 &&
    guardrailTrips === 0 &&
    failed === 0 &&
    errored.length === 0 &&
    deferred.length === 0 &&
    auditMergeWorthy === 0 &&
    (identity?.summary.flaggedMachineUsers ?? 0) === 0;

  return {
    modes: [...modeSet],
    cycles,
    audit: auditCompliance,
    identity,
    totals: {
      drift,
      guardrailTrips,
      guardrailBlocked,
      applied,
      failed,
      cyclesReporting: cycles.length,
      auditMergeWorthy,
    },
    errored,
    deferred,
    clean,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the compliance report to a human-readable string for stdout or a
 * check-run summary. Mirrors the audit summary's plain layout.
 */
export function renderComplianceReport(report: ComplianceReport): string {
  const lines: string[] = [];

  lines.push("=== compliance report ===");
  if (report.generatedAt) lines.push(`generated: ${report.generatedAt}`);
  if (report.modes.length > 0) lines.push(`modes: ${report.modes.join(", ")}`);
  lines.push("");

  if (report.cycles.length === 0) {
    lines.push("  (no cycle results)");
  } else {
    for (const c of report.cycles) {
      const d = c.drift;
      let line =
        `  ${c.cycle}@${c.org}` +
        `  drift=${d.total} (c${d.create}/u${d.update}/d${d.delete})` +
        `  applied=${c.applied}  failed=${c.failed}`;
      if (c.guardrails.blocked) line += `  GUARDRAIL-BLOCKED[${c.guardrails.tripped.join(",")}]`;
      else if (!c.guardrails.ok) line += `  guardrail-trip[${c.guardrails.tripped.join(",")}]`;
      lines.push(line);
    }
  }

  if (report.errored.length > 0) {
    lines.push("");
    lines.push("--- errored cycles ---");
    for (const e of report.errored) {
      lines.push(`  ${e.cycle}@${e.org} (${e.stage}): ${e.error}`);
    }
  }

  if (report.deferred.length > 0) {
    lines.push("");
    lines.push(`--- deferred (budget) ---`);
    lines.push(`  ${report.deferred.join(", ")}`);
  }

  if (report.audit) {
    lines.push("");
    lines.push("--- audit ---");
    lines.push(
      `  total=${report.audit.total}  merge-worthy=${report.audit.mergeWorthy}` +
        `  (quick-win=${report.audit.quickWin}, needs-review=${report.audit.needsReview}, report-only=${report.audit.reportOnly})`,
    );
  }

  if (report.identity) {
    lines.push("");
    lines.push(renderIdentityReport(report.identity).trimEnd());
  }

  lines.push("");
  lines.push("--- totals ---");
  const t = report.totals;
  lines.push(`  drift=${t.drift}  applied=${t.applied}  failed=${t.failed}`);
  lines.push(`  guardrail-trips=${t.guardrailTrips}  guardrail-blocked=${t.guardrailBlocked}`);
  lines.push(`  cycles-reporting=${t.cyclesReporting}  audit-merge-worthy=${t.auditMergeWorthy}`);
  lines.push(`  status: ${report.clean ? "CLEAN" : "ATTENTION NEEDED"}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Serialize the report as a committable JSON artifact (stable two-space
 * indentation, deterministic key order from the object literal).
 */
export function complianceArtifact(report: ComplianceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
