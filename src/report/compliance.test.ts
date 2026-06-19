/**
 * Tests for the compliance reporting aggregator.
 *
 * Pure unit tests over mock ReconcileResult / PostureReport — no network.
 */

import { describe, it, expect } from "vitest";
import {
  buildComplianceReport,
  renderComplianceReport,
  complianceArtifact,
} from "./compliance.js";
import type { ReconcileResult, CycleResult } from "../reconcile/runner.js";
import type { PostureReport } from "../audit/engine.js";

// ---------------------------------------------------------------------------
// Builders for mock run results
// ---------------------------------------------------------------------------

function cycleResult(overrides: Partial<CycleResult> = {}): CycleResult {
  return {
    name: "branch-protection",
    org: "test-org",
    counts: { create: 0, update: 0, delete: 0 },
    guardrails: { ok: true },
    applied: [],
    failed: [],
    plan: "Plan",
    guardrailBlocked: false,
    ...overrides,
  };
}

function reconcileResult(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    mode: "dry-run",
    completed: true,
    cycles: [],
    errored: [],
    deferred: { skippedCycles: [], skippedEntries: [] },
    budgetRemaining: 1000,
    ...overrides,
  };
}

function postureReport(totals: Partial<PostureReport["totals"]> = {}): PostureReport {
  return {
    repos: [],
    totals: { quickWin: 0, needsReview: 0, reportOnly: 0, total: 0, ...totals },
  };
}

// ---------------------------------------------------------------------------
// buildComplianceReport
// ---------------------------------------------------------------------------

describe("buildComplianceReport", () => {
  it("reports clean when there is no drift, no audit findings, no failures", () => {
    const report = buildComplianceReport([reconcileResult({ cycles: [cycleResult()] })]);
    expect(report.clean).toBe(true);
    expect(report.totals.drift).toBe(0);
    expect(report.totals.cyclesReporting).toBe(1);
  });

  it("aggregates drift counts across cycles and orgs", () => {
    const report = buildComplianceReport([
      reconcileResult({
        cycles: [
          cycleResult({ name: "org-settings", counts: { create: 1, update: 2, delete: 0 } }),
          cycleResult({ name: "membership", org: "org-b", counts: { create: 0, update: 1, delete: 3 } }),
        ],
      }),
    ]);
    expect(report.totals.drift).toBe(7);
    expect(report.cycles[0]!.drift).toEqual({ create: 1, update: 2, delete: 0, total: 3 });
    expect(report.cycles[1]!.drift.total).toBe(4);
    expect(report.clean).toBe(false);
  });

  it("captures guardrail trips and blocks", () => {
    const report = buildComplianceReport([
      reconcileResult({
        mode: "apply",
        cycles: [
          cycleResult({
            counts: { create: 1, update: 0, delete: 0 },
            guardrails: { ok: false, diagnostics: [{ guardrail: "adminFloor", message: "m" }] },
            guardrailBlocked: true,
          }),
        ],
      }),
    ]);
    expect(report.totals.guardrailTrips).toBe(1);
    expect(report.totals.guardrailBlocked).toBe(1);
    expect(report.cycles[0]!.guardrails.tripped).toEqual(["adminFloor"]);
    expect(report.modes).toEqual(["apply"]);
  });

  it("tallies applied and failed entries", () => {
    const report = buildComplianceReport([
      reconcileResult({
        mode: "apply",
        cycles: [
          cycleResult({
            counts: { create: 2, update: 0, delete: 0 },
            applied: [{ kind: "create", resourceType: "member", key: "a" }],
            failed: [{ entry: { kind: "create", resourceType: "member", key: "b" }, error: "boom" }],
          }),
        ],
      }),
    ]);
    expect(report.totals.applied).toBe(1);
    expect(report.totals.failed).toBe(1);
    expect(report.clean).toBe(false);
  });

  it("collects errored and deferred cycles", () => {
    const report = buildComplianceReport([
      reconcileResult({
        completed: false,
        errored: [{ name: "teams", org: "test-org", stage: "fetchLive", error: "rate limited" }],
        deferred: { skippedCycles: ["rulesets@test-org"], skippedEntries: [] },
      }),
    ]);
    expect(report.errored).toHaveLength(1);
    expect(report.deferred).toEqual(["rulesets@test-org"]);
    expect(report.clean).toBe(false);
  });

  it("folds in the audit report and computes merge-worthy", () => {
    const report = buildComplianceReport(
      [reconcileResult({ cycles: [cycleResult()] })],
      postureReport({ quickWin: 2, needsReview: 1, reportOnly: 5, total: 8 }),
    );
    expect(report.audit).toEqual({
      total: 8,
      quickWin: 2,
      needsReview: 1,
      reportOnly: 5,
      mergeWorthy: 3,
    });
    expect(report.totals.auditMergeWorthy).toBe(3);
    expect(report.clean).toBe(false); // merge-worthy findings present
  });

  it("stays clean when audit has only report-only findings", () => {
    const report = buildComplianceReport(
      [reconcileResult({ cycles: [cycleResult()] })],
      postureReport({ reportOnly: 4, total: 4 }),
    );
    expect(report.totals.auditMergeWorthy).toBe(0);
    expect(report.clean).toBe(true);
  });

  it("merges multiple reconcile results and dedupes modes", () => {
    const report = buildComplianceReport([
      reconcileResult({ mode: "dry-run", cycles: [cycleResult()] }),
      reconcileResult({ mode: "dry-run", cycles: [cycleResult({ name: "teams" })] }),
    ]);
    expect(report.modes).toEqual(["dry-run"]);
    expect(report.totals.cyclesReporting).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// renderComplianceReport / complianceArtifact
// ---------------------------------------------------------------------------

describe("renderComplianceReport", () => {
  it("renders a clean report with CLEAN status", () => {
    const out = renderComplianceReport(buildComplianceReport([reconcileResult({ cycles: [cycleResult()] })]));
    expect(out).toContain("=== compliance report ===");
    expect(out).toContain("status: CLEAN");
  });

  it("flags attention and shows guardrail blocks + audit", () => {
    const report = buildComplianceReport(
      [
        reconcileResult({
          mode: "apply",
          cycles: [
            cycleResult({
              counts: { create: 0, update: 0, delete: 4 },
              guardrails: { ok: false, diagnostics: [{ guardrail: "removalDeltaCap", message: "m" }] },
              guardrailBlocked: true,
            }),
          ],
        }),
      ],
      postureReport({ quickWin: 1, total: 1 }),
    );
    const out = renderComplianceReport({ ...report, generatedAt: "2026-06-19T00:00:00Z" });
    expect(out).toContain("generated: 2026-06-19T00:00:00Z");
    expect(out).toContain("GUARDRAIL-BLOCKED[removalDeltaCap]");
    expect(out).toContain("--- audit ---");
    expect(out).toContain("status: ATTENTION NEEDED");
  });

  it("handles an empty result set", () => {
    const out = renderComplianceReport(buildComplianceReport([]));
    expect(out).toContain("(no cycle results)");
    expect(out).toContain("status: CLEAN");
  });
});

describe("complianceArtifact", () => {
  it("produces stable, parseable JSON ending in a newline", () => {
    const report = buildComplianceReport([reconcileResult({ cycles: [cycleResult()] })]);
    const json = complianceArtifact(report);
    expect(json.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(json);
    expect(parsed.totals.cyclesReporting).toBe(1);
    expect(parsed.clean).toBe(true);
  });
});
