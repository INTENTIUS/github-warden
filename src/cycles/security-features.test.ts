/**
 * Tests for the security-features cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: keeps repos with a security block, strips the rest
 *   - fetchRepoSecurity: security_and_analysis + the two Dependabot endpoints
 *   - buildSecurityAnalysisBody: declared flags → status objects
 *   - diff over the cycle: repo-security create / update / no-op
 *   - apply: PATCH security_and_analysis + PUT/DELETE Dependabot endpoints
 *   - runner integration: dry-run + apply; license-gated PATCH reported as failed
 */

import { describe, it, expect } from "vitest";
import {
  securityFeaturesCycle,
  fetchRepoSecurity,
  buildSecurityAnalysisBody,
} from "./security-features.js";
import type { SecurityFeaturesScope } from "./security-features.js";
import type { AppClient } from "../auth/app-client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { runReconcile, BudgetExhaustedError } from "../reconcile/runner.js";
import { diff } from "../reconcile/diff.js";
import type { LiveOrgState } from "../reconcile/diff.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockCall {
  method: string;
  path: string;
  body?: unknown;
}

interface MockClient extends AppClient {
  calls: MockCall[];
  responses: Map<string, unknown>;
}

function makeMockClient(responses: Record<string, unknown> = {}): MockClient {
  const calls: MockCall[] = [];
  const responseMap = new Map(Object.entries(responses));
  return {
    calls,
    responses: responseMap,
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (responseMap.has(key)) return responseMap.get(key) as T;
      return {} as T;
    },
  };
}

function makeBudget(initial = 100): RateBudget {
  let remaining = initial;
  return {
    get remaining() {
      return remaining;
    },
    get exhausted() {
      return remaining <= 0;
    },
    use(n = 1) {
      if (remaining <= 0) throw new BudgetExhaustedError();
      remaining = Math.max(0, remaining - n);
    },
  };
}

const scope: SecurityFeaturesScope = {};

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("securityFeaturesCycle.buildDesired", () => {
  it("keeps only repos with a security block", () => {
    const orgConfig: OrgConfig = {
      repos: {
        svc: { security: { secretScanning: true }, description: "x" },
        bare: { description: "no security" },
      },
    };
    const desired = securityFeaturesCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired.repos!["svc"]).toEqual({ security: { secretScanning: true } });
    expect(desired.repos).not.toHaveProperty("bare");
  });
});

// ---------------------------------------------------------------------------
// 2. fetchRepoSecurity
// ---------------------------------------------------------------------------

describe("fetchRepoSecurity", () => {
  it("maps security_and_analysis and both Dependabot endpoints", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/svc": {
        security_and_analysis: {
          advanced_security: { status: "enabled" },
          secret_scanning: { status: "disabled" },
          secret_scanning_push_protection: { status: "enabled" },
        },
      },
      // vulnerability-alerts present → 204-style empty (enabled)
      "GET /repos/test-org/svc/vulnerability-alerts": {},
      "GET /repos/test-org/svc/automated-security-fixes": { enabled: true },
    });
    const live = await fetchRepoSecurity(client, "test-org", "svc", makeBudget());
    expect(live).toEqual({
      advancedSecurity: true,
      secretScanning: false,
      secretScanningPushProtection: true,
      vulnerabilityAlerts: true,
      dependabotSecurityUpdates: true,
    });
  });

  it("treats 404 on the Dependabot endpoints as disabled", async () => {
    const client: MockClient = makeMockClient({
      "GET /repos/test-org/svc": { security_and_analysis: {} },
    });
    const base = client.request;
    client.request = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
      if (path.endsWith("/vulnerability-alerts") || path.endsWith("/automated-security-fixes")) {
        client.calls.push({ method, path });
        throw new Error("GET ... returned 404: Not Found");
      }
      return base<T>(method, path, body);
    };
    const live = await fetchRepoSecurity(client, "test-org", "svc", makeBudget());
    expect(live.vulnerabilityAlerts).toBe(false);
    expect(live.dependabotSecurityUpdates).toBe(false);
  });

  it("omits security_and_analysis features absent from the response (e.g. no GHAS)", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/svc": { security_and_analysis: { secret_scanning: { status: "enabled" } } },
      "GET /repos/test-org/svc/automated-security-fixes": { enabled: false },
    });
    const live = await fetchRepoSecurity(client, "test-org", "svc", makeBudget());
    expect(live.advancedSecurity).toBeUndefined();
    expect(live.secretScanning).toBe(true);
  });

  it("charges three calls per repo", async () => {
    const client = makeMockClient({ "GET /repos/test-org/svc": { security_and_analysis: {} } });
    const budget = makeBudget(10);
    await fetchRepoSecurity(client, "test-org", "svc", budget);
    expect(budget.remaining).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 3. buildSecurityAnalysisBody
// ---------------------------------------------------------------------------

describe("buildSecurityAnalysisBody", () => {
  it("maps declared flags to status objects", () => {
    expect(
      buildSecurityAnalysisBody({
        advancedSecurity: true,
        secretScanning: false,
        secretScanningPushProtection: true,
      }),
    ).toEqual({
      advanced_security: { status: "enabled" },
      secret_scanning: { status: "disabled" },
      secret_scanning_push_protection: { status: "enabled" },
    });
  });

  it("omits Dependabot-only flags (handled by dedicated endpoints)", () => {
    expect(buildSecurityAnalysisBody({ vulnerabilityAlerts: true, dependabotSecurityUpdates: true })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 4. diff over the cycle
// ---------------------------------------------------------------------------

describe("diff integration with security-features cycle", () => {
  const desiredConfig: OrgConfig = {
    repos: { svc: { security: { secretScanning: true, vulnerabilityAlerts: true } } },
  };

  it("emits repo-security create when no live security exists", () => {
    const desired = securityFeaturesCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, { repos: { svc: {} } });
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.resourceType).toBe("repo-security");
    expect(cs.entries[0]!.kind).toBe("create");
    expect(cs.entries[0]!.key).toBe("svc");
  });

  it("emits update when a declared flag differs", () => {
    const live: LiveOrgState = {
      repos: { svc: { security: { secretScanning: false, vulnerabilityAlerts: true } } },
    };
    const desired = securityFeaturesCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, live);
    expect(cs.entries[0]!.kind).toBe("update");
    expect(cs.entries[0]!.fields!.map((f) => f.field)).toEqual(["secretScanning"]);
  });

  it("emits no entries when live matches desired", () => {
    const live: LiveOrgState = {
      repos: { svc: { security: { secretScanning: true, vulnerabilityAlerts: true } } },
    };
    const desired = securityFeaturesCycle.buildDesired(desiredConfig, "test-org", scope);
    expect(diff("test-org", desired, live).entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. apply
// ---------------------------------------------------------------------------

describe("securityFeaturesCycle.apply", () => {
  it("PATCHes security_and_analysis and toggles the Dependabot endpoints", async () => {
    const client = makeMockClient();
    await securityFeaturesCycle.apply(
      client,
      {
        kind: "update",
        resourceType: "repo-security",
        key: "svc",
        after: { secretScanning: true, vulnerabilityAlerts: true, dependabotSecurityUpdates: false },
      },
      "my-org",
      scope,
      makeBudget(),
    );
    const patch = client.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/repos/my-org/svc");
    expect(patch.body).toEqual({ security_and_analysis: { secret_scanning: { status: "enabled" } } });

    const alerts = client.calls.find((c) => c.path.endsWith("/vulnerability-alerts"))!;
    expect(alerts.method).toBe("PUT");
    const fixes = client.calls.find((c) => c.path.endsWith("/automated-security-fixes"))!;
    expect(fixes.method).toBe("DELETE");
  });

  it("skips the PATCH when only Dependabot flags are declared", async () => {
    const client = makeMockClient();
    await securityFeaturesCycle.apply(
      client,
      { kind: "create", resourceType: "repo-security", key: "svc", after: { vulnerabilityAlerts: true } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls.every((c) => c.method !== "PATCH")).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe("PUT");
  });

  it("ignores foreign and delete entries", async () => {
    const client = makeMockClient();
    await securityFeaturesCycle.apply(
      client,
      { kind: "delete", resourceType: "repo-security", key: "svc", before: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    await securityFeaturesCycle.apply(
      client,
      { kind: "create", resourceType: "repo", key: "svc", after: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Runner integration
// ---------------------------------------------------------------------------

describe("securityFeaturesCycle via runReconcile", () => {
  const config: GovernanceConfig = {
    orgs: { "test-org": { repos: { svc: { security: { secretScanning: true } } } } },
  };
  const scopeWithRepos: SecurityFeaturesScope = { repos: config.orgs["test-org"]!.repos };

  it("dry-run: reports an update without mutating", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/svc": { security_and_analysis: { secret_scanning: { status: "disabled" } } },
    });
    const result = await runReconcile({
      config,
      client,
      cycles: [securityFeaturesCycle],
      scope: scopeWithRepos,
      mode: "dry-run",
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("license-gated PATCH surfaces as a reported failed entry, not a crash", async () => {
    const client: MockClient = makeMockClient({
      "GET /repos/test-org/svc": { security_and_analysis: { secret_scanning: { status: "disabled" } } },
    });
    const base = client.request;
    client.request = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
      if (method === "PATCH") {
        client.calls.push({ method, path, body });
        throw new Error("PATCH /repos/test-org/svc returned 422: Advanced Security is not available");
      }
      return base<T>(method, path, body);
    };
    const result = await runReconcile({
      config,
      client,
      cycles: [securityFeaturesCycle],
      scope: scopeWithRepos,
      mode: "apply",
      allowGuardrailOverride: true,
    });
    const cr = result.cycles[0]!;
    expect(cr.applied).toHaveLength(0);
    expect(cr.failed).toHaveLength(1);
    expect(cr.failed[0]!.error).toContain("Advanced Security is not available");
  });
});
