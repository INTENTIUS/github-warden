/**
 * Hermetic compose smoke suite — exercises every registered cycle against the
 * stateful mock GitHub (e2e/mock-github/server.mjs, via e2e/docker-compose.yml
 * or plain `node e2e/mock-github/server.mjs`). Complements the non-hermetic
 * real-App e2e in warden.e2e.test.ts: the mock validates warden's own
 * read→diff→apply loop end to end; the real suite validates the live API
 * contract.
 *
 * ## Gating
 * Skips entirely unless GITHUB_WARDEN_E2E_URL is set (e.g.
 * http://localhost:8188). The mock is throwaway by construction, so there is
 * no separate apply gate.
 *
 * ## Coverage
 * See e2e/README.md for the cycle-by-cycle table. Per cycle: apply from a
 * policy, re-run to a converged (empty) plan, mutate out-of-band and re-run to
 * correct the drift, and (where a delete is plannable) a real delete under
 * `owned`. Plus the guardrail-block path (removalDeltaCap trip on a
 * mass-removal policy edit) and the permission-gated 403 NOTE path (the mock
 * 403s one slice). Auth goes through the real App flow: a generated RSA key
 * signs the App JWT, the mock's /app/installations/{id}/access_tokens mints
 * the installation token.
 */

import { describe, it, beforeAll, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createAppClient, type AppClient } from "../src/auth/app-client.js";
import { CYCLE_REGISTRY } from "../src/cli/registry.js";
import { repoBaselineCycle } from "../src/cycles/repo-baseline.js";
import { runReconcile } from "../src/reconcile/runner.js";
import type { Cycle, CycleResult, RateBudget, ReconcileResult } from "../src/reconcile/runner.js";
import type { GuardrailConfig } from "../src/reconcile/guardrails.js";
import type { OrgConfig } from "../src/config/types.js";

const BASE = process.env.GITHUB_WARDEN_E2E_URL?.replace(/\/$/, "");
const MOCK_TOKEN = process.env.GITHUB_WARDEN_E2E_TOKEN ?? "mock-installation-token";

const suite = BASE ? describe : describe.skip;
if (!BASE) {
  // eslint-disable-next-line no-console
  console.warn(
    "[smoke] skipped — run `just e2e-up` (or `node e2e/mock-github/server.mjs`) and set GITHUB_WARDEN_E2E_URL=http://localhost:8188.",
  );
}

const ORG = "mock-org";
const DEPENDABOT_CONTENT = "version: 2\nupdates: []\n";

/**
 * The full declared policy for the org. Each per-cycle block below runs with
 * its slice of this object, and the final convergence check runs the whole
 * registry against the whole thing — so the slices must stay in agreement
 * with what the per-cycle blocks applied and corrected.
 */
const POLICY: OrgConfig = {
  owned: true,
  settings: {
    description: "Managed by github-warden",
    defaultRepositoryPermission: "read",
    membersCanCreatePublicRepositories: false,
  },
  members: [
    { login: "alice", role: "admin" },
    { login: "carol", role: "admin" },
    { login: "bob", role: "member" },
  ],
  teams: {
    platform: {
      description: "Platform team",
      privacy: "closed",
      members: [{ login: "alice", role: "maintainer" }],
      repos: [{ name: "app", permission: "push" }],
    },
  },
  rulesets: [{ name: "org-baseline", enforcement: "evaluate" }],
  secrets: [{ name: "ORG_DEPLOY_KEY" }],
  variables: [{ name: "ENV_NAME", value: "prod" }],
  repoBaselines: [
    { name: "provisioned" },
    { name: "from-template", template: `${ORG}/app` },
  ],
  tokenPolicy: { revokeExpired: true },
  tokenApproval: { allowedPermissions: ["repository:contents"], default: "deny" },
  repos: {
    app: {
      description: "Primary service",
      hasIssues: true,
      topics: ["governed"],
      branchProtection: [
        { pattern: "main", requirePullRequestReviews: true, requiredApprovingReviewCount: 1 },
      ],
      rulesets: [
        {
          name: "protect-main",
          enforcement: "active",
          // No exclude on purpose — the mock echoes `exclude: []` back the way
          // GitHub does, so convergence here proves the normalization fix.
          conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
          rules: [{ type: "pull_request" }],
        },
      ],
      security: { secretScanning: true, vulnerabilityAlerts: true, dependabotSecurityUpdates: true },
      environments: [{ name: "production", waitTimer: 5 }],
      secrets: [{ name: "APP_DEPLOY_KEY" }],
      variables: [{ name: "REGION", value: "us-east-1" }],
      dependabot: { content: DEPENDABOT_CONTENT },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Raw mock call — out-of-band mutations and live-state verification. */
async function raw<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : undefined) as T,
    headers: res.headers,
  };
}

/** Test controls bypass auth. */
async function mockControl(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  expect(res.ok).toBe(true);
}

function makeBudget(initial = 500): RateBudget {
  let remaining = initial;
  return {
    get remaining() {
      return remaining;
    },
    get exhausted() {
      return remaining <= 0;
    },
    use(n = 1) {
      remaining = Math.max(0, remaining - n);
    },
  };
}

suite("github-warden smoke (mock GitHub)", () => {
  let client: AppClient;

  /** Run the named cycles over a policy slice through warden's real runner. */
  async function reconcile(
    cycleNames: string[],
    cfg: OrgConfig,
    opts: { mode?: "dry-run" | "apply"; guardrails?: GuardrailConfig } = {},
  ): Promise<ReconcileResult> {
    const result = await runReconcile({
      config: { orgs: { [ORG]: cfg } },
      client,
      cycles: cycleNames.map((n) => CYCLE_REGISTRY[n] as Cycle<unknown>),
      scope: { repos: cfg.repos, teams: cfg.teams },
      mode: opts.mode ?? "apply",
      guardrails: opts.guardrails,
    });
    expect(result.errored).toEqual([]);
    return result;
  }

  /** The single cycle result of a one-cycle run, asserted apply-clean. */
  function only(result: ReconcileResult, expectClean = true): CycleResult {
    expect(result.cycles).toHaveLength(1);
    const cr = result.cycles[0]!;
    if (expectClean) {
      expect(cr.guardrailBlocked).toBe(false);
      expect(cr.failed).toEqual([]);
    }
    return cr;
  }

  function expectConverged(cr: CycleResult): void {
    expect(cr.counts).toEqual({ create: 0, update: 0, delete: 0 });
    expect(cr.plan).toContain("No changes.");
  }

  /** Dry-run one cycle over its policy slice and assert an empty plan. */
  async function expectCycleConverged(name: string, cfg: OrgConfig): Promise<void> {
    expectConverged(only(await reconcile([name], cfg, { mode: "dry-run" })));
  }

  beforeAll(async () => {
    await mockControl("/__mock/reset", { org: ORG });

    // Real App auth flow against the mock: generated RSA key → App JWT →
    // installation token from the mock's token endpoint.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    client = createAppClient({
      appId: "1",
      installationId: "42",
      privateKeyPem,
      baseUrl: BASE,
    });

    // The managed repo exists up front (repo-settings never creates repos);
    // declared secret values are provisioned out-of-band, as in production.
    await raw("POST", `/orgs/${ORG}/repos`, { name: "app", private: true });
    await raw("PUT", `/orgs/${ORG}/actions/secrets/ORG_DEPLOY_KEY`, {});
    await raw("PUT", `/repos/${ORG}/app/actions/secrets/APP_DEPLOY_KEY`, {});

    // Fine-grained PAT state (not creatable via the public API).
    await mockControl(`/__mock/orgs/${ORG}/token-grants`, [
      { id: 501, owner_login: "old-bot", token_expired: true, access_granted_at: "2024-01-01T00:00:00Z" },
      {
        id: 502,
        owner_login: "dev-bot",
        token_expired: false,
        access_granted_at: new Date().toISOString(),
        token_last_used_at: new Date().toISOString(),
      },
    ]);
    await mockControl(`/__mock/orgs/${ORG}/token-requests`, [
      { id: 601, owner_login: "dev1", permissions: { repository: { contents: "read" } } },
      { id: 602, owner_login: "dev2", permissions: { organization: { members: "write" } } },
    ]);
  });

  // ── Phase 0: every cycle's fetchLive is read-only ─────────────────────────

  describe("fetchLive is read-only", () => {
    it("no cycle's fetchLive issues a mutating request", async () => {
      const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
      for (const cycle of Object.values(CYCLE_REGISTRY)) {
        const methods: string[] = [];
        const recording: AppClient = {
          request: async <T = unknown>(method: string, path: string, body?: unknown) => {
            methods.push(method);
            return client.request<T>(method, path, body);
          },
        };
        await cycle.fetchLive(
          recording,
          ORG,
          { repos: POLICY.repos, teams: POLICY.teams },
          makeBudget(),
        );
        const mutating = methods.filter((m) => MUTATING.has(m));
        expect(mutating, `${cycle.name} fetchLive mutated`).toEqual([]);
      }
    });
  });

  // ── org-settings ──────────────────────────────────────────────────────────

  describe("org-settings", () => {
    const cfg: OrgConfig = { settings: POLICY.settings };

    it("applies the declared settings", async () => {
      const cr = only(await reconcile(["org-settings"], cfg));
      expect(cr.counts.update + cr.counts.create).toBeGreaterThan(0);
      const live = await raw<{ description: string; members_can_create_public_repositories: boolean }>(
        "GET",
        `/orgs/${ORG}`,
      );
      expect(live.body.description).toBe("Managed by github-warden");
      expect(live.body.members_can_create_public_repositories).toBe(false);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("org-settings", cfg);
    });

    it("corrects out-of-band drift", async () => {
      await raw("PATCH", `/orgs/${ORG}`, { description: "tampered" });
      const plan = only(await reconcile(["org-settings"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      expect(plan.plan).toContain("description");
      only(await reconcile(["org-settings"], cfg));
      const live = await raw<{ description: string }>("GET", `/orgs/${ORG}`);
      expect(live.body.description).toBe("Managed by github-warden");
    });
  });

  // ── repo-settings ─────────────────────────────────────────────────────────

  describe("repo-settings", () => {
    const cfg: OrgConfig = { repos: POLICY.repos };

    it("applies description + topics", async () => {
      only(await reconcile(["repo-settings"], cfg));
      const live = await raw<{ description: string; topics: string[] }>("GET", `/repos/${ORG}/app`);
      expect(live.body.description).toBe("Primary service");
      expect(live.body.topics).toEqual(["governed"]);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("repo-settings", cfg);
    });

    it("corrects out-of-band drift", async () => {
      await raw("PATCH", `/repos/${ORG}/app`, { has_issues: false });
      const plan = only(await reconcile(["repo-settings"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      only(await reconcile(["repo-settings"], cfg));
      const live = await raw<{ has_issues: boolean }>("GET", `/repos/${ORG}/app`);
      expect(live.body.has_issues).toBe(true);
    });
  });

  // ── membership (incl. the guardrail-block path) ───────────────────────────

  describe("membership", () => {
    const cfg: OrgConfig = { owned: ["member"], members: POLICY.members };

    it("adds the declared members and roles", async () => {
      const cr = only(await reconcile(["membership"], cfg));
      expect(cr.counts.create).toBe(3);
      const admins = await raw<Array<{ login: string }>>("GET", `/orgs/${ORG}/members?role=admin`);
      expect(admins.body.map((m) => m.login).sort()).toEqual(["alice", "carol"]);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("membership", cfg);
    });

    it("corrects an out-of-band role escalation", async () => {
      await raw("PUT", `/orgs/${ORG}/memberships/bob`, { role: "admin" });
      const plan = only(await reconcile(["membership"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      only(await reconcile(["membership"], cfg));
      const admins = await raw<Array<{ login: string }>>("GET", `/orgs/${ORG}/members?role=admin`);
      expect(admins.body.map((m) => m.login).sort()).toEqual(["alice", "carol"]);
    });

    it("deletes an undeclared member under `owned` (1 of 4 live members = 25%, within the cap)", async () => {
      // The realistic converged-cleanup case: the stale delete is the ONLY
      // plan entry, so plan-relative it would read 1 of 1 = 100% and always
      // block. It passes only because removalDeltaCap divides by the member
      // type's live count (4) from the change set's managedCounts — no cap
      // raise needed.
      await raw("PUT", `/orgs/${ORG}/memberships/stray`, { role: "member" });
      const cr = only(await reconcile(["membership"], cfg));
      expect(cr.counts.delete).toBe(1);
      const members = await raw<Array<{ login: string }>>("GET", `/orgs/${ORG}/members`);
      expect(members.body.map((m) => m.login)).not.toContain("stray");
    });

    it("removalDeltaCap blocks dropping 1 of 3 members from the policy (33% > 25%)", async () => {
      const shrunk: OrgConfig = {
        owned: ["member"],
        members: POLICY.members!.filter((m) => m.login !== "bob"),
      };
      const result = await reconcile(["membership"], shrunk);
      const cr = only(result, false);
      expect(cr.guardrailBlocked).toBe(true);
      expect(cr.guardrails.ok).toBe(false);
      if (!cr.guardrails.ok) {
        expect(cr.guardrails.diagnostics[0]!.guardrail).toBe("removalDeltaCap");
        // The per-type message names the offending type and its live denominator.
        expect(cr.guardrails.diagnostics[0]!.message).toContain("1 of 3 live member entries (33%)");
      }
      // Nothing was removed.
      const members = await raw<Array<{ login: string }>>("GET", `/orgs/${ORG}/members`);
      expect(members.body.map((m) => m.login)).toContain("bob");
    });
  });

  // ── teams ─────────────────────────────────────────────────────────────────

  describe("teams", () => {
    const cfg: OrgConfig = { owned: ["team"], teams: POLICY.teams };

    it("creates the team with members and repo access", async () => {
      only(await reconcile(["teams"], cfg));
      const team = await raw<{ description: string; privacy: string }>(
        "GET",
        `/orgs/${ORG}/teams/platform`,
      );
      expect(team.body.description).toBe("Platform team");
      expect(team.body.privacy).toBe("closed");
      const maintainers = await raw<Array<{ login: string }>>(
        "GET",
        `/orgs/${ORG}/teams/platform/members?role=maintainer`,
      );
      expect(maintainers.body.map((m) => m.login)).toEqual(["alice"]);
      const repos = await raw<Array<{ name: string; role_name: string }>>(
        "GET",
        `/orgs/${ORG}/teams/platform/repos`,
      );
      expect(repos.body).toEqual([{ name: "app", role_name: "push" }]);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("teams", cfg);
    });

    it("corrects an out-of-band description change", async () => {
      await raw("PATCH", `/orgs/${ORG}/teams/platform`, { description: "tampered" });
      const plan = only(await reconcile(["teams"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      only(await reconcile(["teams"], cfg));
      const team = await raw<{ description: string }>("GET", `/orgs/${ORG}/teams/platform`);
      expect(team.body.description).toBe("Platform team");
    });

    it("deletes an undeclared team under `owned` once the cap is raised", async () => {
      await raw("POST", `/orgs/${ORG}/teams`, { name: "stray" });
      // 1 delete of 2 live team entries = 50% — over the default 25% cap now
      // that the denominator is per type (team members and repo grants no
      // longer pad it). The cap is not under test here; raise it for the
      // deliberate cleanup.
      const cr = only(
        await reconcile(["teams"], cfg, {
          guardrails: { removalDeltaCap: { maxFraction: 0.5 } },
        }),
      );
      expect(cr.counts.delete).toBe(1);
      const gone = await raw("GET", `/orgs/${ORG}/teams/stray`);
      expect(gone.status).toBe(404);
    });
  });

  // ── branch-protection ─────────────────────────────────────────────────────

  describe("branch-protection", () => {
    const cfg: OrgConfig = { repos: POLICY.repos };

    it("protects the declared branch", async () => {
      const cr = only(await reconcile(["branch-protection"], cfg));
      expect(cr.counts.create).toBe(1);
      const live = await raw<{
        required_pull_request_reviews: { required_approving_review_count: number };
      }>("GET", `/repos/${ORG}/app/branches/main/protection`);
      expect(live.body.required_pull_request_reviews.required_approving_review_count).toBe(1);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("branch-protection", cfg);
    });

    it("re-protects after an out-of-band unprotect", async () => {
      await raw("DELETE", `/repos/${ORG}/app/branches/main/protection`);
      const plan = only(await reconcile(["branch-protection"], cfg, { mode: "dry-run" }));
      expect(plan.counts.create).toBe(1);
      only(await reconcile(["branch-protection"], cfg));
      const live = await raw("GET", `/repos/${ORG}/app/branches/main/protection`);
      expect(live.status).toBe(200);
    });

    // No delete leg: the classic-protection probe only reads DECLARED patterns
    // (documented limitation), so an undeclared live rule is invisible to the
    // diff and a delete is never plannable from this cycle.
  });

  // ── rulesets (org + repo, incl. the exclude:[] echo) ──────────────────────

  describe("rulesets", () => {
    const cfg: OrgConfig = { owned: true, rulesets: POLICY.rulesets, repos: POLICY.repos };

    it("creates the org and repo rulesets", async () => {
      const cr = only(await reconcile(["rulesets"], cfg));
      expect(cr.counts.create).toBe(2);
      const orgList = await raw<Array<{ id: number; name: string }>>("GET", `/orgs/${ORG}/rulesets`);
      expect(orgList.body.map((r) => r.name)).toEqual(["org-baseline"]);
      const repoList = await raw<Array<{ id: number; name: string }>>(
        "GET",
        `/repos/${ORG}/app/rulesets`,
      );
      expect(repoList.body.map((r) => r.name)).toEqual(["protect-main"]);
      // The mock echoes exclude: [] the way GitHub does.
      const detail = await raw<{ conditions: { ref_name: { exclude: string[] } } }>(
        "GET",
        `/repos/${ORG}/app/rulesets/${repoList.body[0]!.id}`,
      );
      expect(detail.body.conditions.ref_name.exclude).toEqual([]);
    });

    it("re-run converges despite the exclude:[] echo (audit finding 1)", async () => {
      await expectCycleConverged("rulesets", cfg);
    });

    it("corrects an out-of-band enforcement downgrade", async () => {
      const list = await raw<Array<{ id: number; name: string }>>("GET", `/orgs/${ORG}/rulesets`);
      const id = list.body.find((r) => r.name === "org-baseline")!.id;
      await raw("PUT", `/orgs/${ORG}/rulesets/${id}`, { name: "org-baseline", enforcement: "disabled" });
      const plan = only(await reconcile(["rulesets"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      only(await reconcile(["rulesets"], cfg));
      const detail = await raw<{ enforcement: string }>("GET", `/orgs/${ORG}/rulesets/${id}`);
      expect(detail.body.enforcement).toBe("evaluate");
    });

    it("deletes an undeclared ruleset under `owned` once the cap is raised", async () => {
      await raw("POST", `/orgs/${ORG}/rulesets`, { name: "stray", enforcement: "active" });
      // 1 delete of 2 live org-ruleset entries = 50% — the repo ruleset and
      // the managed repo no longer pad the denominator now that the cap is per
      // type. The cap is not under test here; raise it for the cleanup.
      const cr = only(
        await reconcile(["rulesets"], cfg, {
          guardrails: { removalDeltaCap: { maxFraction: 0.5 } },
        }),
      );
      expect(cr.counts.delete).toBe(1);
      const list = await raw<Array<{ name: string }>>("GET", `/orgs/${ORG}/rulesets`);
      expect(list.body.map((r) => r.name)).toEqual(["org-baseline"]);
    });
  });

  // ── security-features ─────────────────────────────────────────────────────

  describe("security-features", () => {
    const cfg: OrgConfig = { repos: POLICY.repos };

    it("enables the declared toggles", async () => {
      only(await reconcile(["security-features"], cfg));
      const repo = await raw<{ security_and_analysis: { secret_scanning: { status: string } } }>(
        "GET",
        `/repos/${ORG}/app`,
      );
      expect(repo.body.security_and_analysis.secret_scanning.status).toBe("enabled");
      const alerts = await raw("GET", `/repos/${ORG}/app/vulnerability-alerts`);
      expect(alerts.status).toBe(204);
      const fixes = await raw<{ enabled: boolean }>("GET", `/repos/${ORG}/app/automated-security-fixes`);
      expect(fixes.body.enabled).toBe(true);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("security-features", cfg);
    });

    it("re-enables after an out-of-band disable", async () => {
      await raw("DELETE", `/repos/${ORG}/app/vulnerability-alerts`);
      const plan = only(await reconcile(["security-features"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      only(await reconcile(["security-features"], cfg));
      const alerts = await raw("GET", `/repos/${ORG}/app/vulnerability-alerts`);
      expect(alerts.status).toBe(204);
    });
  });

  // ── environments ──────────────────────────────────────────────────────────

  describe("environments", () => {
    const cfg: OrgConfig = { owned: ["environment"], repos: POLICY.repos };

    it("creates the declared environment", async () => {
      only(await reconcile(["environments"], cfg));
      const live = await raw<{ environments: Array<{ name: string; protection_rules: unknown[] }> }>(
        "GET",
        `/repos/${ORG}/app/environments`,
      );
      expect(live.body.environments.map((e) => e.name)).toEqual(["production"]);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("environments", cfg);
    });

    it("corrects an out-of-band wait-timer change", async () => {
      await raw("PUT", `/repos/${ORG}/app/environments/production`, { wait_timer: 30 });
      const plan = only(await reconcile(["environments"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      only(await reconcile(["environments"], cfg));
      const live = await raw<{
        environments: Array<{ protection_rules: Array<{ type: string; wait_timer?: number }> }>;
      }>("GET", `/repos/${ORG}/app/environments`);
      expect(live.body.environments[0]!.protection_rules[0]).toMatchObject({ wait_timer: 5 });
    });

    it("deletes an undeclared environment under `owned` once the cap is raised", async () => {
      await raw("PUT", `/repos/${ORG}/app/environments/staging`, { wait_timer: 1 });
      // 1 delete of 2 live environment entries = 50% — over the default 25%
      // per-type cap (the managed repo no longer pads the denominator). The
      // cap is not under test here; raise it for the deliberate cleanup.
      const cr = only(
        await reconcile(["environments"], cfg, {
          guardrails: { removalDeltaCap: { maxFraction: 0.5 } },
        }),
      );
      expect(cr.counts.delete).toBe(1);
      const live = await raw<{ environments: Array<{ name: string }> }>(
        "GET",
        `/repos/${ORG}/app/environments`,
      );
      expect(live.body.environments.map((e) => e.name)).toEqual(["production"]);
    });
  });

  // ── secrets-variables (incl. the 403 NOTE path) ───────────────────────────

  describe("secrets-variables", () => {
    const cfg: OrgConfig = {
      owned: true,
      secrets: POLICY.secrets,
      variables: POLICY.variables,
      repos: POLICY.repos,
    };

    it("creates the declared variables (secrets pre-provisioned by name)", async () => {
      const cr = only(await reconcile(["secrets-variables"], cfg));
      expect(cr.counts.create).toBe(2); // ENV_NAME + REGION; both secrets already live
      const orgVars = await raw<{ variables: Array<{ name: string; value: string }> }>(
        "GET",
        `/orgs/${ORG}/actions/variables`,
      );
      expect(orgVars.body.variables).toEqual([{ name: "ENV_NAME", value: "prod" }]);
      const repoVars = await raw<{ variables: Array<{ name: string; value: string }> }>(
        "GET",
        `/repos/${ORG}/app/actions/variables`,
      );
      expect(repoVars.body.variables).toEqual([{ name: "REGION", value: "us-east-1" }]);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("secrets-variables", cfg);
    });

    it("corrects an out-of-band value change", async () => {
      await raw("PATCH", `/repos/${ORG}/app/actions/variables/REGION`, { value: "eu-west-1" });
      const plan = only(await reconcile(["secrets-variables"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      only(await reconcile(["secrets-variables"], cfg));
      const repoVars = await raw<{ variables: Array<{ value: string }> }>(
        "GET",
        `/repos/${ORG}/app/actions/variables`,
      );
      expect(repoVars.body.variables[0]!.value).toBe("us-east-1");
    });

    it("deletes an undeclared variable under `owned` once the cap is raised", async () => {
      await raw("POST", `/orgs/${ORG}/actions/variables`, { name: "STRAY", value: "x" });
      // 1 delete of 2 live org-variable entries = 50% — secrets and repo-level
      // entries no longer pad the denominator now that the cap is per type.
      // The cap is not under test here; raise it for the cleanup.
      const cr = only(
        await reconcile(["secrets-variables"], cfg, {
          guardrails: { removalDeltaCap: { maxFraction: 0.5 } },
        }),
      );
      expect(cr.counts.delete).toBe(1);
      const orgVars = await raw<{ variables: Array<{ name: string }> }>(
        "GET",
        `/orgs/${ORG}/actions/variables`,
      );
      expect(orgVars.body.variables.map((v) => v.name)).toEqual(["ENV_NAME"]);
    });

    it("a permission-gated read (403) yields a plan NOTE, not an errored cycle", async () => {
      await mockControl("/__mock/forbid", { prefix: `/orgs/${ORG}/actions/variables` });
      const cr = only(await reconcile(["secrets-variables"], cfg, { mode: "dry-run" }), false);
      expect(cr.plan).toContain(
        "NOTE: org-variables: read was permission-gated (403); planned entries may fail on apply",
      );
      // The hidden slice plans optimistically (ENV_NAME shows as a create).
      expect(cr.counts.create).toBe(1);
      await mockControl("/__mock/allow");
      await expectCycleConverged("secrets-variables", cfg);
    });
  });

  // ── dependency-hygiene ────────────────────────────────────────────────────

  describe("dependency-hygiene", () => {
    const cfg: OrgConfig = { repos: POLICY.repos };

    it("creates the dependabot config file", async () => {
      const cr = only(await reconcile(["dependency-hygiene"], cfg));
      expect(cr.counts.create).toBe(1);
      const file = await raw<{ content: string }>(
        "GET",
        `/repos/${ORG}/app/contents/.github/dependabot.yml`,
      );
      expect(Buffer.from(file.body.content, "base64").toString("utf-8")).toBe(DEPENDABOT_CONTENT);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("dependency-hygiene", cfg);
    });

    it("corrects out-of-band file drift (sha-aware update commit)", async () => {
      const before = await raw<{ sha: string }>(
        "GET",
        `/repos/${ORG}/app/contents/.github/dependabot.yml`,
      );
      await raw("PUT", `/repos/${ORG}/app/contents/.github/dependabot.yml`, {
        message: "tamper",
        content: Buffer.from("version: 1\n", "utf-8").toString("base64"),
        sha: before.body.sha,
      });
      const plan = only(await reconcile(["dependency-hygiene"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      only(await reconcile(["dependency-hygiene"], cfg));
      const file = await raw<{ content: string }>(
        "GET",
        `/repos/${ORG}/app/contents/.github/dependabot.yml`,
      );
      expect(Buffer.from(file.body.content, "base64").toString("utf-8")).toBe(DEPENDABOT_CONTENT);
    });
  });

  // ── repo-baseline ─────────────────────────────────────────────────────────

  describe("repo-baseline", () => {
    const cfg: OrgConfig = { repoBaselines: POLICY.repoBaselines };

    it("creates missing repos (empty and from a template)", async () => {
      const cr = only(await reconcile(["repo-baseline"], cfg));
      expect(cr.counts.create).toBe(2);
      expect((await raw("GET", `/repos/${ORG}/provisioned`)).status).toBe(200);
      expect((await raw("GET", `/repos/${ORG}/from-template`)).status).toBe(200);
    });

    it("re-run converges (existence-only; never updates or deletes)", async () => {
      await expectCycleConverged("repo-baseline", cfg);
    });
  });

  // ── token-governance ──────────────────────────────────────────────────────

  describe("token-governance", () => {
    const cfg: OrgConfig = { tokenPolicy: POLICY.tokenPolicy };

    it("revokes the expired grant and keeps the healthy one", async () => {
      const plan = only(await reconcile(["token-governance"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(1);
      expect(plan.plan).toContain("[token-grant] 501");
      only(await reconcile(["token-governance"], cfg));
      const grants = await raw<Array<{ id: number }>>("GET", `/orgs/${ORG}/personal-access-tokens`);
      expect(grants.body.map((g) => g.id)).toEqual([502]);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("token-governance", cfg);
    });
  });

  // ── token-approval ────────────────────────────────────────────────────────

  describe("token-approval", () => {
    const cfg: OrgConfig = { tokenApproval: POLICY.tokenApproval };

    it("approves the allowed request and denies the rest (default: deny)", async () => {
      const plan = only(await reconcile(["token-approval"], cfg, { mode: "dry-run" }));
      expect(plan.counts.update).toBe(2);
      expect(plan.plan).toContain("[token-request] 601");
      expect(plan.plan).toContain("[token-request] 602");
      only(await reconcile(["token-approval"], cfg));
      const pending = await raw<unknown[]>("GET", `/orgs/${ORG}/personal-access-token-requests`);
      expect(pending.body).toEqual([]);
    });

    it("re-run converges to an empty plan", async () => {
      await expectCycleConverged("token-approval", cfg);
    });
  });

  // ── Full-registry convergence over the whole policy ───────────────────────

  describe("full registry", () => {
    it("a dry-run of all 13 cycles over the full policy is drift-free", async () => {
      const result = await reconcile(Object.keys(CYCLE_REGISTRY), POLICY, { mode: "dry-run" });
      expect(result.cycles).toHaveLength(Object.keys(CYCLE_REGISTRY).length);
      for (const cr of result.cycles) {
        expect(cr.counts, `${cr.name} not converged:\n${cr.plan}`).toEqual({
          create: 0,
          update: 0,
          delete: 0,
        });
        expect(cr.guardrails.ok).toBe(true);
      }
      expect(result.completed).toBe(true);
    });
  });

  // ── Pagination (Link headers + short-page detection) ──────────────────────

  describe("pagination", () => {
    it("pages through a >100-entry repo list", async () => {
      for (let i = 0; i < 120; i++) {
        await raw("POST", `/orgs/${ORG}/repos`, { name: `pad-${String(i).padStart(3, "0")}` });
      }
      // The mock advertises the next page via a Link header…
      const page1 = await raw("GET", `/orgs/${ORG}/repos?per_page=50&page=1`);
      expect(page1.headers.get("link")).toContain('rel="next"');
      // …and the client's paginator walks pages until a short page.
      const budget = makeBudget(10);
      const live = await repoBaselineCycle.fetchLive(client, ORG, {}, budget);
      // app + provisioned + from-template + 120 pads.
      expect(Object.keys(live.repos ?? {})).toHaveLength(123);
      expect(budget.remaining).toBe(8); // exactly two 100-per-page requests
    });
  });
});
