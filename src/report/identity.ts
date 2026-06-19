/**
 * Identity & service-account hygiene report.
 *
 * A detect-and-report pass (no mutation): inventories the org's installed
 * GitHub Apps and flags operator-declared machine/service-account logins that
 * are seat-consuming org members, recommending migration to Apps (which consume
 * no seat).
 *
 * Pure and deterministic. The CLI fetches the raw inputs (installations,
 * members) and the operator declares known machine users via config; this
 * module only classifies and renders.
 *
 * ## Why machine users are operator-declared
 *
 * GitHub's API does not reliably mark a "machine user" — they are ordinary user
 * accounts used as bots. So warden cannot auto-detect them; the org declares
 * the known ones (`OrgConfig.machineUsers`) and this report cross-references
 * them against live membership.
 */

// ---------------------------------------------------------------------------
// Input shapes (subset of the GitHub installation object we read)
// ---------------------------------------------------------------------------

/** Raw GitHub app-installation fields we read. */
export interface RawInstallation {
  app_slug?: string;
  app_id?: number;
  permissions?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Public report types
// ---------------------------------------------------------------------------

/** An installed App (consumes no seat). */
export interface InstalledApp {
  slug: string;
  appId?: number;
  /** Number of permission scopes granted to the installation. */
  permissionCount: number;
}

/** The identity & service-account hygiene report. */
export interface IdentityReport {
  installations: {
    count: number;
    apps: InstalledApp[];
  };
  machineUsers: {
    /** Declared machine users that ARE org members (seat-consuming). */
    flagged: string[];
    /** Declared machine users not currently org members. */
    notMembers: string[];
  };
  summary: {
    installationCount: number;
    flaggedMachineUsers: number;
  };
  /** Human-readable recommendations. */
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// buildIdentityReport
// ---------------------------------------------------------------------------

/**
 * Build the identity report from installed apps, the org member logins, and the
 * declared machine-user logins. Pure.
 */
export function buildIdentityReport(
  installations: RawInstallation[],
  memberLogins: string[],
  machineUserLogins: string[],
): IdentityReport {
  const apps: InstalledApp[] = installations.map((i) => ({
    slug: i.app_slug ?? "unknown",
    appId: i.app_id,
    permissionCount: i.permissions ? Object.keys(i.permissions).length : 0,
  }));

  const memberSet = new Set(memberLogins);
  // De-dupe declared machine users while preserving order.
  const declared = [...new Set(machineUserLogins)];
  const flagged = declared.filter((l) => memberSet.has(l));
  const notMembers = declared.filter((l) => !memberSet.has(l));

  const recommendations: string[] = [];
  for (const login of flagged) {
    recommendations.push(
      `Machine user "${login}" consumes an org seat — replace it with a GitHub App (Apps consume no seat).`,
    );
  }

  return {
    installations: { count: apps.length, apps },
    machineUsers: { flagged, notMembers },
    summary: { installationCount: apps.length, flaggedMachineUsers: flagged.length },
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render the identity report to a human-readable section. */
export function renderIdentityReport(report: IdentityReport): string {
  const lines: string[] = [];
  lines.push("--- identity & service-account hygiene ---");
  lines.push(`  installed apps: ${report.installations.count} (seat-free)`);
  for (const a of report.installations.apps) {
    lines.push(`    ${a.slug}  permissions=${a.permissionCount}`);
  }
  lines.push(
    `  machine users: ${report.machineUsers.flagged.length} flagged` +
      (report.machineUsers.notMembers.length
        ? `, ${report.machineUsers.notMembers.length} declared-not-member`
        : ""),
  );
  for (const r of report.recommendations) {
    lines.push(`    ⚠ ${r}`);
  }
  lines.push("");
  return lines.join("\n");
}
