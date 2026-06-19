/**
 * Format a PostureReport as a human-readable posture summary for CLI output.
 */

import type { PostureReport } from "./engine.js";

export type FailOn = "merge-worthy" | "any" | "none";

/**
 * Render the posture report to a string.
 *
 * Layout:
 *   Per-repo: one line with finding counts and tiers.
 *   Footer: aggregated totals + tier legend.
 */
export function renderPostureSummary(report: PostureReport): string {
  const lines: string[] = [];

  lines.push("=== posture audit ===");
  lines.push("");

  for (const r of report.repos) {
    if (r.error) {
      lines.push(`  ${r.slug}  ERROR: ${r.error}`);
      continue;
    }
    const c = r.model.counts;
    lines.push(
      `  ${r.slug}` +
        `  scanned=${r.scanned}` +
        `  total=${c.total}` +
        `  quick-win=${c.quickWin}` +
        `  needs-review=${c.needsReview}` +
        `  report-only=${c.reportOnly}`,
    );
  }

  lines.push("");
  lines.push("--- totals ---");
  lines.push(`  total=${report.totals.total}`);
  lines.push(`  quick-win=${report.totals.quickWin}  (merge-worthy: deterministic auto-fix)`);
  lines.push(`  needs-review=${report.totals.needsReview}  (merge-worthy: guidance / manual)`);
  lines.push(`  report-only=${report.totals.reportOnly}  (informational)`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Determine whether the report should cause a non-zero exit.
 *
 * "merge-worthy" = quick-win + needs-review (mirrors chant audit --fail-on merge-worthy).
 * "any"          = any finding at all.
 * "none"         = never fail (default).
 */
export function shouldFail(report: PostureReport, failOn: FailOn): boolean {
  switch (failOn) {
    case "merge-worthy":
      return report.totals.quickWin + report.totals.needsReview > 0;
    case "any":
      return report.totals.total > 0;
    case "none":
    default:
      return false;
  }
}
