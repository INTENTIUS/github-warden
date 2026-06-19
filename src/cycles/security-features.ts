/**
 * Security-feature enforcement cycle.
 *
 * Reconciles repository security features:
 *   - GitHub Advanced Security, secret scanning, secret-scanning push
 *     protection — via the repo `security_and_analysis` object
 *     (`PATCH /repos/{o}/{r}`).
 *   - Dependabot vulnerability alerts — `vulnerability-alerts` endpoint.
 *   - Dependabot automated security fixes — `automated-security-fixes` endpoint.
 *
 *   GET    /repos/{o}/{r}                          — security_and_analysis state
 *   GET    /repos/{o}/{r}/vulnerability-alerts     — 204 enabled / 404 disabled
 *   GET    /repos/{o}/{r}/automated-security-fixes — { enabled } / 404
 *   PATCH  /repos/{o}/{r}                          — set security_and_analysis
 *   PUT/DELETE the two dedicated endpoints         — toggle Dependabot features
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## License-gated graceful degradation
 *
 * Advanced Security (and secret scanning on private repos) requires a GHAS
 * license. When unavailable, GitHub rejects the enabling PATCH; rather than
 * crashing the run, that surfaces as a reported *failed entry* in the cycle
 * result (the runner continues past it). So an org mixing GHAS and non-GHAS
 * repos reconciles the available features everywhere and reports the rest.
 *
 * ## Scope
 *
 * Live state is fetched for repos in `scope.repos` that declare a `security`
 * block (the branch-protection scope pattern). With no scope, declared repos
 * appear as creates serviced idempotently by the apply writes.
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, RepoConfig, RepoSecurityConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveRepoSecurity } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/** Scope for the security-features cycle. Pass `repos` (typically `orgConfig.repos`). */
export interface SecurityFeaturesScope {
  repos?: Record<string, RepoConfig>;
}

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GhSecurityStatus {
  status?: "enabled" | "disabled" | string | null;
}

interface GhRepoSecurity {
  security_and_analysis?: {
    advanced_security?: GhSecurityStatus | null;
    secret_scanning?: GhSecurityStatus | null;
    secret_scanning_push_protection?: GhSecurityStatus | null;
  } | null;
}

interface GhAutomatedFixes {
  enabled?: boolean;
}

/** True when a repo config declares any security feature. */
function hasManagedSecurity(repo: RepoConfig): boolean {
  return repo.security !== undefined;
}

// ---------------------------------------------------------------------------
// Live-state fetch
// ---------------------------------------------------------------------------

function statusToBool(s: GhSecurityStatus | null | undefined): boolean | undefined {
  if (s == null || s.status == null) return undefined;
  return s.status === "enabled";
}

/** Fetch the security-feature state for one repo (up to 3 API calls). */
export async function fetchRepoSecurity(
  client: AppClient,
  org: string,
  repo: string,
  budget: RateBudget,
): Promise<LiveRepoSecurity> {
  const live: LiveRepoSecurity = {};

  // 1. security_and_analysis via repo GET.
  budget.use(1);
  const repoData = await client.request<GhRepoSecurity>("GET", `/repos/${org}/${repo}`);
  const saa = repoData.security_and_analysis ?? {};
  const adv = statusToBool(saa.advanced_security);
  const ss = statusToBool(saa.secret_scanning);
  const ssp = statusToBool(saa.secret_scanning_push_protection);
  if (adv !== undefined) live.advancedSecurity = adv;
  if (ss !== undefined) live.secretScanning = ss;
  if (ssp !== undefined) live.secretScanningPushProtection = ssp;

  // 2. Dependabot vulnerability alerts: 204 → enabled, 404 → disabled.
  if (!budget.exhausted) {
    budget.use(1);
    try {
      await client.request("GET", `/repos/${org}/${repo}/vulnerability-alerts`);
      live.vulnerabilityAlerts = true;
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) {
        live.vulnerabilityAlerts = false;
      } else {
        throw err;
      }
    }
  }

  // 3. Dependabot automated security fixes.
  if (!budget.exhausted) {
    budget.use(1);
    try {
      const fixes = await client.request<GhAutomatedFixes>(
        "GET",
        `/repos/${org}/${repo}/automated-security-fixes`,
      );
      live.dependabotSecurityUpdates = fixes.enabled === true;
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) {
        live.dependabotSecurityUpdates = false;
      } else {
        throw err;
      }
    }
  }

  return live;
}

// ---------------------------------------------------------------------------
// Apply helpers
// ---------------------------------------------------------------------------

/** Build the `security_and_analysis` PATCH body from declared flags (empty if none). */
export function buildSecurityAnalysisBody(desired: RepoSecurityConfig): Record<string, unknown> {
  const saa: Record<string, unknown> = {};
  if (desired.advancedSecurity !== undefined) {
    saa.advanced_security = { status: desired.advancedSecurity ? "enabled" : "disabled" };
  }
  if (desired.secretScanning !== undefined) {
    saa.secret_scanning = { status: desired.secretScanning ? "enabled" : "disabled" };
  }
  if (desired.secretScanningPushProtection !== undefined) {
    saa.secret_scanning_push_protection = {
      status: desired.secretScanningPushProtection ? "enabled" : "disabled",
    };
  }
  return saa;
}

// ---------------------------------------------------------------------------
// securityFeaturesCycle — implements Cycle<SecurityFeaturesScope>
// ---------------------------------------------------------------------------

export const securityFeaturesCycle: Cycle<SecurityFeaturesScope> = {
  name: "security-features",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    scope: SecurityFeaturesScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const repos: NonNullable<LiveOrgState["repos"]> = {};
    for (const [name, repoConfig] of Object.entries(scope?.repos ?? {})) {
      if (!hasManagedSecurity(repoConfig)) continue;
      if (budget.exhausted) break;
      repos[name] = { security: await fetchRepoSecurity(client, orgLogin, name, budget) };
    }

    return { repos };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: SecurityFeaturesScope): OrgConfig {
    if (!orgConfig.repos) return {};
    const repos: Record<string, RepoConfig> = {};
    for (const [name, repoConfig] of Object.entries(orgConfig.repos)) {
      if (hasManagedSecurity(repoConfig)) repos[name] = { security: repoConfig.security };
    }
    return { repos };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: SecurityFeaturesScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "repo-security") return;
    if (entry.kind === "delete") return; // security features are toggled, never "deleted"

    const repo = entry.key;
    const desired = entry.after as RepoSecurityConfig;

    // 1. security_and_analysis (advanced security, secret scanning, push protection).
    const saa = buildSecurityAnalysisBody(desired);
    if (Object.keys(saa).length > 0) {
      budget.use(1);
      await client.request("PATCH", `/repos/${orgLogin}/${repo}`, { security_and_analysis: saa });
    }

    // 2. Dependabot vulnerability alerts (dedicated endpoint).
    if (desired.vulnerabilityAlerts !== undefined) {
      budget.use(1);
      const method = desired.vulnerabilityAlerts ? "PUT" : "DELETE";
      await client.request(method, `/repos/${orgLogin}/${repo}/vulnerability-alerts`);
    }

    // 3. Dependabot automated security fixes (dedicated endpoint).
    if (desired.dependabotSecurityUpdates !== undefined) {
      budget.use(1);
      const method = desired.dependabotSecurityUpdates ? "PUT" : "DELETE";
      await client.request(method, `/repos/${orgLogin}/${repo}/automated-security-fixes`);
    }
  },
};
