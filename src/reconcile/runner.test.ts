import { describe, it, expect } from "vitest";
import { runReconcile, BudgetExhaustedError } from "./runner.js";
import type { Cycle, RateBudget } from "./runner.js";
import type { AppClient } from "../auth/app-client.js";
import type { ChangeSetEntry, LiveOrgState } from "./diff.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";
import { loadGovernanceConfig } from "../config/load.js";
import { securityFeaturesCycle } from "../cycles/security-features.js";
import { secretsVariablesCycle } from "../cycles/secrets-variables.js";

// ---------------------------------------------------------------------------
// Mock client — records every request; the runner itself never calls request,
// only cycles do. A bare mock proves the runner performs zero network I/O on
// its own.
// ---------------------------------------------------------------------------

interface MockClient extends AppClient {
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function makeMockClient(): MockClient {
  const calls: MockClient["calls"] = [];
  return {
    calls,
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      return undefined as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake cycle factory — fully synthetic, no network. `live` and `desired` are
// injected so each test controls the diff. `onApply` records applied entries.
// ---------------------------------------------------------------------------

interface FakeCycleOptions {
  name?: string;
  live?: LiveOrgState;
  desired?: OrgConfig;
  /** Hook invoked inside fetchLive (e.g. to consume budget). */
  onFetch?: (budget: RateBudget) => void;
  /** Hook invoked inside apply (e.g. to consume budget or throw). */
  onApply?: (entry: ChangeSetEntry, budget: RateBudget) => void;
}

function makeFakeCycle(opts: FakeCycleOptions = {}): Cycle & {
  fetchCount: number;
  applied: ChangeSetEntry[];
} {
  const state = {
    fetchCount: 0,
    applied: [] as ChangeSetEntry[],
    name: opts.name ?? "fake",
    async fetchLive(_client: AppClient, _orgLogin: string, _scope: unknown, budget: RateBudget): Promise<LiveOrgState> {
      state.fetchCount++;
      opts.onFetch?.(budget);
      return opts.live ?? {};
    },
    buildDesired(config: OrgConfig, _orgLogin: string): OrgConfig {
      // Default: use the org config as-is unless an override is provided.
      return opts.desired ?? config;
    },
    async apply(_client: AppClient, entry: ChangeSetEntry, _orgLogin: string, _scope: unknown, budget: RateBudget): Promise<void> {
      opts.onApply?.(entry, budget);
      state.applied.push(entry);
    },
  };
  return state;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function configWithMembers(
  members: Array<{ login: string; role?: "admin" | "member" }>,
): GovernanceConfig {
  return { orgs: { "test-org": { members } } };
}

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

describe("runReconcile — dry-run (default)", () => {
  it("defaults to dry-run and performs zero mutations", async () => {
    const client = makeMockClient();
    // Desired adds 3 members that don't exist live → 3 creates.
    const cycle = makeFakeCycle({
      live: { members: [{ login: "keeper", role: "admin" }] },
      desired: {
        members: [
          { login: "keeper", role: "admin" },
          { login: "alice", role: "member" },
          { login: "bob", role: "member" },
        ],
      },
    });

    const result = await runReconcile({
      config: configWithMembers([{ login: "keeper", role: "admin" }]),
      client,
      cycles: [cycle],
      // mode omitted → dry-run
    });

    expect(result.mode).toBe("dry-run");
    expect(result.completed).toBe(true);
    // No apply ever called.
    expect(cycle.applied).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
    // Plan still computed.
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]!.counts.create).toBe(2);
    expect(result.cycles[0]!.applied).toHaveLength(0);
    expect(result.cycles[0]!.plan).toContain("Plan for test-org");
  });

  it("explicit dry-run mode also mutates nothing", async () => {
    const client = makeMockClient();
    const cycle = makeFakeCycle({
      desired: { members: [{ login: "alice", role: "member" }] },
    });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [cycle],
      mode: "dry-run",
    });

    expect(cycle.applied).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
    expect(result.cycles[0]!.counts.create).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// per-scope ownership (`owned`) → delete planning
// ---------------------------------------------------------------------------

describe("runReconcile — per-scope ownership", () => {
  // One live-only team: `teams` is managed (declared, empty) but "ghost" only
  // exists live. Whether its delete is planned depends purely on `owned`.
  const liveWithGhostTeam: LiveOrgState = {
    teams: { ghost: { description: "live-only team" } },
  };

  it("plans no deletes when `owned` is absent (default)", async () => {
    const cycle = makeFakeCycle({ live: liveWithGhostTeam });

    const result = await runReconcile({
      config: { orgs: { "test-org": { teams: {} } } },
      client: makeMockClient(),
      cycles: [cycle],
    });

    expect(result.cycles[0]!.counts.delete).toBe(0);
    expect(result.cycles[0]!.plan).toContain("No changes.");
  });

  it("plans deletes for live-only resources when `owned: true`", async () => {
    const cycle = makeFakeCycle({ live: liveWithGhostTeam });

    const result = await runReconcile({
      config: { orgs: { "test-org": { owned: true, teams: {} } } },
      client: makeMockClient(),
      cycles: [cycle],
    });

    expect(result.cycles[0]!.counts.delete).toBe(1);
    expect(result.cycles[0]!.plan).toContain("[team] ghost");
  });

  it("string[] variant only unlocks the listed resource types", async () => {
    // Live has a ghost team AND a ghost member; only "member" is owned.
    const cycle = makeFakeCycle({
      live: {
        teams: { ghost: { description: "live-only team" } },
        members: [
          { login: "admin1", role: "admin" },
          { login: "admin2", role: "admin" },
          { login: "ghost", role: "member" },
        ],
      },
    });

    const result = await runReconcile({
      config: {
        orgs: {
          "test-org": {
            owned: ["member"],
            teams: {},
            members: [
              { login: "admin1", role: "admin" },
              { login: "admin2", role: "admin" },
            ],
          },
        },
      },
      client: makeMockClient(),
      cycles: [cycle],
    });

    const cr = result.cycles[0]!;
    expect(cr.counts.delete).toBe(1);
    expect(cr.plan).toContain("[member] ghost");
    expect(cr.plan).not.toContain("[team] ghost");
  });

  it("a caller-supplied diffOptions.isOwned wins over the scope's `owned`", async () => {
    const cycle = makeFakeCycle({ live: liveWithGhostTeam });

    const result = await runReconcile({
      config: { orgs: { "test-org": { owned: true, teams: {} } } },
      client: makeMockClient(),
      cycles: [cycle],
      diffOptions: { isOwned: () => false },
    });

    expect(result.cycles[0]!.counts.delete).toBe(0);
  });

  it("owned deletes still pass through guardrails (removalDeltaCap)", async () => {
    // Deleting the only pre-existing managed team is a 100% removal delta —
    // removalDeltaCap (25%) must trip and block the apply.
    const cycle = makeFakeCycle({ live: liveWithGhostTeam });

    const result = await runReconcile({
      config: { orgs: { "test-org": { owned: true, teams: {} } } },
      client: makeMockClient(),
      cycles: [cycle],
      mode: "apply",
    });

    const cr = result.cycles[0]!;
    expect(cr.guardrails.ok).toBe(false);
    expect(cr.guardrailBlocked).toBe(true);
    expect(cycle.applied).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// apply — guardrails pass
// ---------------------------------------------------------------------------

describe("runReconcile — apply", () => {
  it("applies entries when guardrails pass", async () => {
    const client = makeMockClient();
    // Two safe creates (no deletes → removalDeltaCap passes; admins preserved).
    const cycle = makeFakeCycle({
      live: { members: [{ login: "admin1", role: "admin" }, { login: "admin2", role: "admin" }] },
      desired: {
        members: [
          { login: "admin1", role: "admin" },
          { login: "admin2", role: "admin" },
          { login: "newbie", role: "member" },
        ],
      },
    });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [cycle],
      mode: "apply",
    });

    expect(result.mode).toBe("apply");
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.guardrailBlocked).toBe(false);
    // The one create was applied.
    expect(cycle.applied).toHaveLength(1);
    expect(cycle.applied[0]!.key).toBe("newbie");
    expect(result.cycles[0]!.applied).toHaveLength(1);
    expect(result.cycles[0]!.failed).toHaveLength(0);
  });

  it("records failed entries without aborting the run", async () => {
    const client = makeMockClient();
    const cycle = makeFakeCycle({
      live: { members: [{ login: "admin1", role: "admin" }, { login: "admin2", role: "admin" }] },
      desired: {
        members: [
          { login: "admin1", role: "admin" },
          { login: "admin2", role: "admin" },
          { login: "boom", role: "member" },
          { login: "ok", role: "member" },
        ],
      },
      onApply: (entry) => {
        if (entry.key === "boom") throw new Error("apply failed");
      },
    });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [cycle],
      mode: "apply",
    });

    const cr = result.cycles[0]!;
    expect(cr.applied.map((e) => e.key)).toEqual(["ok"]);
    expect(cr.failed).toHaveLength(1);
    expect(cr.failed[0]!.entry.key).toBe("boom");
    expect(cr.failed[0]!.error).toBe("apply failed");
  });
});

// ---------------------------------------------------------------------------
// apply — guardrail-blocked
// ---------------------------------------------------------------------------

describe("runReconcile — guardrail-blocked apply", () => {
  it("blocks apply when guardrails trip and override is not set", async () => {
    const client = makeMockClient();
    // Live has 2 admins; desired drops both to member → adminFloor trips.
    const cycle = makeFakeCycle({
      live: { members: [{ login: "admin1", role: "admin" }, { login: "admin2", role: "admin" }] },
      desired: {
        members: [
          { login: "admin1", role: "member" },
          { login: "admin2", role: "member" },
        ],
      },
    });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [cycle],
      mode: "apply",
    });

    const cr = result.cycles[0]!;
    expect(cr.guardrails.ok).toBe(false);
    expect(cr.guardrailBlocked).toBe(true);
    // Nothing applied.
    expect(cycle.applied).toHaveLength(0);
    expect(cr.applied).toHaveLength(0);
  });

  it("applies anyway when allowGuardrailOverride is set", async () => {
    const client = makeMockClient();
    const cycle = makeFakeCycle({
      live: { members: [{ login: "admin1", role: "admin" }, { login: "admin2", role: "admin" }] },
      desired: {
        members: [
          { login: "admin1", role: "member" },
          { login: "admin2", role: "member" },
        ],
      },
    });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [cycle],
      mode: "apply",
      allowGuardrailOverride: true,
    });

    const cr = result.cycles[0]!;
    expect(cr.guardrails.ok).toBe(false);
    expect(cr.guardrailBlocked).toBe(false);
    // Both demotions applied despite the tripped guardrail.
    expect(cr.applied).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// budget exhaustion
// ---------------------------------------------------------------------------

describe("runReconcile — rate budget", () => {
  it("reports deferred cycles when budget is exhausted before fetch", async () => {
    const client = makeMockClient();
    // Each fetch consumes the entire budget. With two cycles, the second is
    // deferred because the budget is exhausted before it starts.
    const cycleA = makeFakeCycle({
      name: "cycle-a",
      onFetch: (budget) => budget.use(1),
    });
    const cycleB = makeFakeCycle({ name: "cycle-b" });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [cycleA, cycleB],
      requestBudget: 1,
    });

    expect(result.completed).toBe(false);
    expect(result.budgetRemaining).toBe(0);
    // cycle-a ran, cycle-b deferred.
    expect(cycleA.fetchCount).toBe(1);
    expect(cycleB.fetchCount).toBe(0);
    expect(result.deferred.skippedCycles).toContain("cycle-b@test-org");
    expect(result.cycles.map((c) => c.name)).toEqual(["cycle-a"]);
  });

  it("records a deferred cycle when fetchLive throws BudgetExhaustedError", async () => {
    const client = makeMockClient();
    const cycle = makeFakeCycle({
      name: "greedy",
      onFetch: () => {
        throw new BudgetExhaustedError();
      },
    });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [cycle],
      requestBudget: 5,
    });

    expect(result.completed).toBe(false);
    expect(result.deferred.skippedCycles).toContain("greedy@test-org");
    expect(result.cycles).toHaveLength(0);
  });

  it("records a cycle as errored and continues when fetchLive throws a generic error", async () => {
    const client = makeMockClient();
    // First cycle's fetchLive throws a non-budget error (e.g. a 403). It must
    // be recorded as errored, and the second cycle must still run.
    const boomCycle = makeFakeCycle({
      name: "boom",
      onFetch: () => {
        throw new Error("403 Forbidden");
      },
    });
    const okCycle = makeFakeCycle({
      name: "ok",
      desired: { members: [{ login: "alice", role: "member" }] },
    });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [boomCycle, okCycle],
    });

    // The run resolves rather than rejecting.
    expect(result.completed).toBe(false);
    // The failing cycle is captured as errored, not as a normal cycle result.
    expect(result.errored).toHaveLength(1);
    expect(result.errored[0]!.name).toBe("boom");
    expect(result.errored[0]!.org).toBe("test-org");
    expect(result.errored[0]!.stage).toBe("fetchLive");
    expect(result.errored[0]!.error).toBe("403 Forbidden");
    // The other cycle still ran to completion.
    expect(okCycle.fetchCount).toBe(1);
    expect(result.cycles.map((c) => c.name)).toEqual(["ok"]);
    expect(result.cycles[0]!.counts.create).toBe(1);
  });

  it("defers unapplied entries when budget runs out mid-apply", async () => {
    const client = makeMockClient();
    // Three safe creates; budget allows exactly one apply.
    const cycle = makeFakeCycle({
      live: { members: [{ login: "admin1", role: "admin" }, { login: "admin2", role: "admin" }] },
      desired: {
        members: [
          { login: "admin1", role: "admin" },
          { login: "admin2", role: "admin" },
          { login: "a", role: "member" },
          { login: "b", role: "member" },
          { login: "c", role: "member" },
        ],
      },
      onApply: (_entry, budget) => budget.use(1),
    });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [cycle],
      mode: "apply",
      requestBudget: 1,
    });

    const cr = result.cycles[0]!;
    expect(cr.applied).toHaveLength(1);
    // The remaining two creates are deferred, not silently dropped.
    expect(result.deferred.skippedEntries).toHaveLength(2);
    expect(result.deferred.skippedEntries.map((s) => s.cycleName)).toEqual(["fake", "fake"]);
    expect(result.completed).toBe(false);
  });

  it("multi-org: each org's cycle invocations target the correct org", async () => {
    // A config with two orgs. We record the orgLogin passed to fetchLive for
    // each invocation and assert that org-a rules go to org-a and org-b rules
    // go to org-b — never to the other org.
    const client = makeMockClient();

    const fetchOrgLogins: string[] = [];
    const applyOrgLogins: string[] = [];

    const cycle: Cycle & { fetchCount: number; applied: ChangeSetEntry[] } = {
      name: "multi-org-check",
      fetchCount: 0,
      applied: [],
      async fetchLive(_client, orgLogin, _scope, _budget) {
        fetchOrgLogins.push(orgLogin);
        cycle.fetchCount++;
        return {};
      },
      buildDesired(config, orgLogin) {
        // Return a single member per org so the diff produces 1 create per org.
        return { members: [{ login: `bot-for-${orgLogin}`, role: "member" as const }] };
      },
      async apply(_client, entry, orgLogin, _scope, _budget) {
        applyOrgLogins.push(orgLogin);
        cycle.applied.push(entry);
      },
    };

    const result = await runReconcile({
      config: {
        orgs: {
          "org-a": {},
          "org-b": {},
        },
      },
      client,
      cycles: [cycle],
      mode: "apply",
      allowGuardrailOverride: true,
    });

    // fetchLive called once per org — in order.
    expect(fetchOrgLogins).toEqual(["org-a", "org-b"]);
    // apply called once per org (one create per org).
    expect(applyOrgLogins).toEqual(["org-a", "org-b"]);
    // Two cycle results, one per org.
    expect(result.cycles).toHaveLength(2);
    expect(result.cycles.map((c) => c.org)).toEqual(["org-a", "org-b"]);
  });

  it("completes cleanly within budget", async () => {
    const client = makeMockClient();
    const cycle = makeFakeCycle({
      desired: { members: [{ login: "alice", role: "member" }] },
      onFetch: (budget) => budget.use(1),
    });

    const result = await runReconcile({
      config: configWithMembers([]),
      client,
      cycles: [cycle],
      requestBudget: 100,
    });

    expect(result.completed).toBe(true);
    expect(result.deferred.skippedCycles).toHaveLength(0);
    expect(result.deferred.skippedEntries).toHaveLength(0);
    expect(result.budgetRemaining).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// CLI-loaded config reachability — slices that the loader forwards reach their
// cycle's buildDesired through the runner. These use the REAL cycles with a
// config produced by loadGovernanceConfig (the CLI path), proving end-to-end
// that a slice typed in config/types.ts is planned, not silently dropped.
// ---------------------------------------------------------------------------

describe("runReconcile — CLI-loaded config reaches cycle buildDesired", () => {
  it("per-repo security from a loaded config is planned by the security-features cycle", async () => {
    // A client whose GETs return an empty object: the live repo exists but has
    // no security_and_analysis block, so declared toggles surface as an update.
    const client: AppClient = {
      async request<T = unknown>(): Promise<T> {
        return {} as T;
      },
    };
    const config = loadGovernanceConfig({
      orgs: {
        "test-org": {
          repos: {
            api: {
              security: { secretScanning: true },
            },
          },
        },
      },
    });

    // Scope points fetchLive at the declared repos so the nested
    // repo-security diff runs against a live repo entry.
    const result = await runReconcile({
      config,
      client,
      cycles: [securityFeaturesCycle as Cycle<unknown>],
      scope: { repos: config.orgs["test-org"].repos },
    });

    expect(result.completed).toBe(true);
    const cr = result.cycles[0]!;
    expect(cr.counts.update).toBe(1);
    expect(cr.plan).toContain("[repo-security] api");
    expect(cr.plan).toContain("secretScanning");
  });

  it("org secrets from a loaded config are planned by the secrets-variables cycle", async () => {
    const client = makeMockClient();
    const config = loadGovernanceConfig({
      orgs: {
        "test-org": {
          secrets: [{ name: "DEPLOY_KEY", rotationRef: "TICKET-42" }],
        },
      },
    });

    // The mock client returns no live secrets, so the declared org secret must
    // surface as a create in the dry-run plan.
    const result = await runReconcile({
      config,
      client,
      cycles: [secretsVariablesCycle as Cycle<unknown>],
    });

    expect(result.completed).toBe(true);
    const cr = result.cycles[0]!;
    expect(cr.counts.create).toBe(1);
    expect(cr.plan).toContain("[org-secret] DEPLOY_KEY");
  });
});

// ---------------------------------------------------------------------------
// removalDeltaCap wiring — each change set carries its own per-type live
// denominators (`managedCounts`, stamped by the diff), so the guardrails a
// cycle×org sees are always measured against that change set's live counts.
// ---------------------------------------------------------------------------

describe("runReconcile — removalDeltaCap (per-type live denominators)", () => {
  /** Live state with `count` members (2 admins + fillers). */
  function liveMembers(count: number): LiveOrgState {
    return {
      members: [
        { login: "admin1", role: "admin" },
        { login: "admin2", role: "admin" },
        ...Array.from({ length: count - 2 }, (_, i) => ({
          login: `user${i}`,
          role: "member" as const,
        })),
      ],
    };
  }

  /** Desired keeping the admins plus the first `keep` fillers. */
  function desiredKeeping(keep: number): OrgConfig {
    return {
      members: [
        { login: "admin1", role: "admin" },
        { login: "admin2", role: "admin" },
        ...Array.from({ length: keep }, (_, i) => ({
          login: `user${i}`,
          role: "member" as const,
        })),
      ],
    };
  }

  it("one stale delete out of 10 live members passes (converged cycle)", async () => {
    // 9 of 10 live members are declared; the 10th is a stale delete. Under the
    // old plan denominator this was 1 delete / 1 non-create entry = 100% and a
    // guaranteed block; under the live denominator it is 10% and passes.
    const cycle = makeFakeCycle({ live: liveMembers(10), desired: desiredKeeping(7) });

    const result = await runReconcile({
      config: { orgs: { "test-org": { owned: ["member"], members: [] } } },
      client: makeMockClient(),
      cycles: [cycle],
      mode: "apply",
    });

    const cr = result.cycles[0]!;
    expect(cr.counts.delete).toBe(1);
    expect(cr.guardrails.ok).toBe(true);
    expect(cr.guardrailBlocked).toBe(false);
    expect(cycle.applied).toHaveLength(1);
  });

  it("4 deletes out of 10 live members blocks", async () => {
    const cycle = makeFakeCycle({ live: liveMembers(10), desired: desiredKeeping(4) });

    const result = await runReconcile({
      config: { orgs: { "test-org": { owned: ["member"], members: [] } } },
      client: makeMockClient(),
      cycles: [cycle],
      mode: "apply",
    });

    const cr = result.cycles[0]!;
    expect(cr.counts.delete).toBe(4);
    expect(cr.guardrails.ok).toBe(false);
    if (!cr.guardrails.ok) {
      expect(cr.guardrails.diagnostics[0]!.guardrail).toBe("removalDeltaCap");
      expect(cr.guardrails.diagnostics[0]!.message).toContain("4 of 10 live member entries");
    }
    expect(cr.guardrailBlocked).toBe(true);
    expect(cycle.applied).toHaveLength(0);
  });

  it("multi-org: each org's guardrails see that org's own live counts", async () => {
    // Two orgs through one cycle. org-a has 10 live members and 1 stale delete
    // (10% — passes); org-b has 4 live members and 1 stale delete (25% — blocks
    // at a tightened 20% threshold, which also proves the caller's cap options
    // reach chant). The denominators travel ON each change set (managedCounts),
    // so each org's guardrails are measured against that org's own live state.
    const liveByOrg: Record<string, LiveOrgState> = {
      "org-a": liveMembers(10),
      "org-b": liveMembers(4),
    };
    const desiredByOrg: Record<string, OrgConfig> = {
      "org-a": desiredKeeping(7), // 1 delete of 10 live = 10%
      "org-b": desiredKeeping(1), // 1 delete of 4 live = 25% → blocks at 20%
    };

    const applied: string[] = [];
    const cycle: Cycle = {
      name: "per-org-counts",
      async fetchLive(_client, orgLogin) {
        return liveByOrg[orgLogin]!;
      },
      buildDesired(_config, orgLogin) {
        return desiredByOrg[orgLogin]!;
      },
      async apply(_client, entry, orgLogin) {
        applied.push(`${orgLogin}:${entry.key}`);
      },
    };

    const result = await runReconcile({
      config: {
        orgs: {
          "org-a": { owned: ["member"] },
          "org-b": { owned: ["member"] },
        },
      },
      client: makeMockClient(),
      cycles: [cycle],
      mode: "apply",
      guardrails: { removalDeltaCap: { maxFraction: 0.2 } },
    });

    const byOrg = Object.fromEntries(result.cycles.map((c) => [c.org, c]));
    expect(byOrg["org-a"]!.guardrails.ok).toBe(true);
    expect(byOrg["org-a"]!.guardrailBlocked).toBe(false);
    expect(byOrg["org-b"]!.guardrails.ok).toBe(false);
    expect(byOrg["org-b"]!.guardrailBlocked).toBe(true);
    if (!byOrg["org-b"]!.guardrails.ok) {
      expect(byOrg["org-b"]!.guardrails.diagnostics[0]!.message).toContain(
        "1 of 4 live member entries",
      );
    }
    // Only org-a's entries were applied — org-b was blocked.
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((k) => k.startsWith("org-a:"))).toBe(true);
  });
});
