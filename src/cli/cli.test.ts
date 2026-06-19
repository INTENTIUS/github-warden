/**
 * Tests for the chant-governance CLI.
 *
 * All tests are pure unit tests: no network, no process.exit, no FS I/O
 * beyond what is mocked inline. We test the exported internal helpers directly
 * to keep the tests deterministic and fast.
 */

import { describe, it, expect } from "vitest";
import { CYCLE_REGISTRY } from "./registry.js";

// ---------------------------------------------------------------------------
// parseReconcileArgs — import the REAL parser from the CLI source so that any
// flag rename in cli.ts is caught here (and in the pipeline⇄CLI consistency
// test below). The parser is a pure function that throws `CliError` on bad
// input; `main()` catches it and exits non-zero.
// ---------------------------------------------------------------------------

import { parseReconcileArgs, parseReportArgs, CliError } from "../cli.js";

// ---------------------------------------------------------------------------
// Arg parsing tests
// ---------------------------------------------------------------------------

describe("parseReconcileArgs", () => {
  it("parses valid token-env invocation", () => {
    const args = parseReconcileArgs([
      "--config",
      ".github/governance.yml",
      "--token-env",
      "GH_TOKEN",
      "--installation-id-env",
      "GOVERNANCE_INSTALLATION_ID",
      "--mode",
      "dry-run",
    ]);
    expect(args.config).toBe(".github/governance.yml");
    expect(args.mode).toBe("dry-run");
    expect(args.tokenEnv).toBe("GH_TOKEN");
    expect(args.allowGuardrailOverride).toBe(false);
  });

  it("parses apply mode", () => {
    const args = parseReconcileArgs([
      "--config",
      "governance.yml",
      "--token-env",
      "GH_TOKEN",
      "--mode",
      "apply",
    ]);
    expect(args.mode).toBe("apply");
  });

  it("parses --cycles as comma-separated list", () => {
    const args = parseReconcileArgs([
      "--config",
      "g.yml",
      "--token-env",
      "GH_TOKEN",
      "--cycles",
      "branch-protection,team-sync",
    ]);
    expect(args.cycles).toEqual(["branch-protection", "team-sync"]);
  });

  it("parses --allow-guardrail-override as boolean flag", () => {
    const args = parseReconcileArgs([
      "--config",
      "g.yml",
      "--token-env",
      "GH_TOKEN",
      "--allow-guardrail-override",
    ]);
    expect(args.allowGuardrailOverride).toBe(true);
  });

  it("parses app-id + installation-id auth path", () => {
    const args = parseReconcileArgs([
      "--config",
      "g.yml",
      "--app-id-env",
      "MY_APP_ID",
      "--installation-id-env",
      "MY_INSTALL_ID",
    ]);
    expect(args.appIdEnv).toBe("MY_APP_ID");
    expect(args.installationIdEnv).toBe("MY_INSTALL_ID");
    expect(args.tokenEnv).toBeUndefined();
  });

  it("throws a CliError with code 2 when --config is missing", () => {
    expect(() => parseReconcileArgs(["--token-env", "GH_TOKEN"])).toThrow(CliError);
    expect(() =>
      parseReconcileArgs(["--token-env", "GH_TOKEN"]),
    ).toThrow(expect.objectContaining({ code: 2 }));
  });

  it("throws code 2 when no auth flag is supplied", () => {
    expect(() => parseReconcileArgs(["--config", "g.yml"])).toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });

  it("throws code 2 for an unknown flag", () => {
    expect(() =>
      parseReconcileArgs(["--config", "g.yml", "--token-env", "GH_TOKEN", "--unknown-flag"]),
    ).toThrow(expect.objectContaining({ code: 2 }));
  });

  it("throws code 2 for an invalid --mode value", () => {
    expect(() =>
      parseReconcileArgs(["--config", "g.yml", "--token-env", "GH_TOKEN", "--mode", "bad"]),
    ).toThrow(expect.objectContaining({ code: 2 }));
  });

  it("throws code 2 for missing --config value", () => {
    expect(() =>
      parseReconcileArgs(["--config", "--token-env", "GH_TOKEN"]),
    ).toThrow(expect.objectContaining({ code: 2 }));
  });
});

// ---------------------------------------------------------------------------
// parseReportArgs
// ---------------------------------------------------------------------------

describe("parseReportArgs", () => {
  it("parses a basic report invocation with defaults", () => {
    const args = parseReportArgs(["--config", "g.yml", "--token-env", "GH_TOKEN"]);
    expect(args.config).toBe("g.yml");
    expect(args.tokenEnv).toBe("GH_TOKEN");
    expect(args.audit).toBe(false);
    expect(args.failOn).toBe("none");
    expect(args.out).toBeUndefined();
    expect(args.cycles).toEqual([]);
  });

  it("parses --out, --audit, --cycles, and --fail-on attention", () => {
    const args = parseReportArgs([
      "--config", "g.yml",
      "--token-env", "GH_TOKEN",
      "--out", "compliance.json",
      "--audit",
      "--cycles", "org-settings,membership",
      "--fail-on", "attention",
    ]);
    expect(args.out).toBe("compliance.json");
    expect(args.audit).toBe(true);
    expect(args.cycles).toEqual(["org-settings", "membership"]);
    expect(args.failOn).toBe("attention");
  });

  it("throws code 2 when auth is missing", () => {
    expect(() => parseReportArgs(["--config", "g.yml"])).toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });

  it("throws code 2 for an invalid --fail-on value", () => {
    expect(() =>
      parseReportArgs(["--config", "g.yml", "--token-env", "GH_TOKEN", "--fail-on", "bad"]),
    ).toThrow(expect.objectContaining({ code: 2 }));
  });

  it("throws CliError for an unknown flag", () => {
    expect(() =>
      parseReportArgs(["--config", "g.yml", "--token-env", "GH_TOKEN", "--nope"]),
    ).toThrow(CliError);
  });
});

// ---------------------------------------------------------------------------
// Cycle registry tests
// ---------------------------------------------------------------------------

describe("CYCLE_REGISTRY", () => {
  it("resolves branch-protection to the branchProtectionCycle", async () => {
    const { branchProtectionCycle } = await import("../cycles/branch-protection.js");
    expect(CYCLE_REGISTRY["branch-protection"]).toBe(branchProtectionCycle);
  });

  it("cycle name matches registry key", () => {
    for (const [key, cycle] of Object.entries(CYCLE_REGISTRY)) {
      expect(cycle.name).toBe(key);
    }
  });

  it("returns undefined for unknown cycle name", () => {
    expect(CYCLE_REGISTRY["nonexistent-cycle"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dry-run / apply / guardrail-block via runReconcile
// ---------------------------------------------------------------------------

import { runReconcile } from "../reconcile/runner.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import type { AppClient } from "../auth/app-client.js";
import type { ChangeSetEntry, LiveOrgState } from "../reconcile/diff.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";

function makeMockClient(): AppClient {
  return {
    async request<T = unknown>(): Promise<T> {
      return undefined as T;
    },
  };
}

function makeSimpleConfig(): GovernanceConfig {
  return {
    orgs: {
      "test-org": {
        members: [
          { login: "alice", role: "admin" },
          { login: "bob", role: "admin" },
        ],
      },
    },
  };
}

/** Cycle that returns a single create entry (creates a member). */
function makeCreateCycle(): Cycle & { applied: ChangeSetEntry[] } {
  const applied: ChangeSetEntry[] = [];
  return {
    name: "fake-create",
    async fetchLive(): Promise<LiveOrgState> {
      // No live members → diff will emit a create for alice.
      return {};
    },
    buildDesired(config: OrgConfig): OrgConfig {
      return config;
    },
    async apply(_client: AppClient, entry: ChangeSetEntry): Promise<void> {
      applied.push(entry);
    },
    applied,
  };
}

/**
 * Cycle that trips the adminFloor guardrail.
 *
 * Config has 1 admin (alice). No live admins. After apply: 1 admin. The
 * default adminFloor min is 2, so the guardrail trips without needing an
 * ownership predicate (adminFloor is based on the post-apply admin count,
 * not on deletes).
 */
function makeGuardrailTripCycle(): Cycle & { applyCallCount: number } {
  const state = { applyCallCount: 0 };
  const cycle: Cycle & { applyCallCount: number } = {
    name: "fake-guardrail",
    applyCallCount: 0,
    async fetchLive(): Promise<LiveOrgState> {
      // No live members → diff emits create for alice.
      return {};
    },
    buildDesired(): OrgConfig {
      // Only 1 admin → adminFloor (default min=2) will trip on apply.
      return { members: [{ login: "alice", role: "admin" }] };
    },
    async apply(): Promise<void> {
      state.applyCallCount++;
      cycle.applyCallCount++;
    },
  };
  return cycle;
}

describe("runReconcile integration (mocked client)", () => {
  it("dry-run produces a plan summary and mutates nothing", async () => {
    const cycle = makeCreateCycle();
    const result = await runReconcile({
      config: makeSimpleConfig(),
      client: makeMockClient(),
      cycles: [cycle],
      mode: "dry-run",
    });

    expect(result.mode).toBe("dry-run");
    expect(result.completed).toBe(true);
    // Dry-run: no entries applied.
    expect(cycle.applied).toHaveLength(0);
    // At least one cycle result.
    expect(result.cycles.length).toBeGreaterThan(0);
    // Plan string is populated.
    for (const cr of result.cycles) {
      expect(typeof cr.plan).toBe("string");
    }
  });

  it("apply mode applies entries and records them", async () => {
    const cycle = makeCreateCycle();
    const result = await runReconcile({
      config: makeSimpleConfig(),
      client: makeMockClient(),
      cycles: [cycle],
      mode: "apply",
    });

    expect(result.mode).toBe("apply");
    expect(result.completed).toBe(true);
    // apply was called for the alice create.
    expect(cycle.applied.length).toBeGreaterThan(0);
    for (const cr of result.cycles) {
      expect(cr.applied.length).toBeGreaterThanOrEqual(0);
      expect(cr.guardrailBlocked).toBe(false);
    }
  });

  it("apply mode with guardrail block sets guardrailBlocked=true", async () => {
    // Config with 1 admin trips adminFloor (default min=2).
    const cycle = makeGuardrailTripCycle();
    const config: GovernanceConfig = {
      orgs: { "test-org": { members: [{ login: "alice", role: "admin" }] } },
    };
    const result = await runReconcile({
      config,
      client: makeMockClient(),
      cycles: [cycle],
      mode: "apply",
      allowGuardrailOverride: false,
    });

    // At least one cycle result should be guardrail-blocked.
    const blocked = result.cycles.filter((cr) => cr.guardrailBlocked);
    expect(blocked.length).toBeGreaterThan(0);
    // apply must NOT have been called.
    expect(cycle.applyCallCount).toBe(0);
  });

  it("allow-guardrail-override lets apply proceed past a tripped guardrail", async () => {
    // Same single-admin config that trips adminFloor, but with override.
    const cycle = makeGuardrailTripCycle();
    const config: GovernanceConfig = {
      orgs: { "test-org": { members: [{ login: "alice", role: "admin" }] } },
    };
    const result = await runReconcile({
      config,
      client: makeMockClient(),
      cycles: [cycle],
      mode: "apply",
      allowGuardrailOverride: true,
    });

    // With override, guardrailBlocked is false and apply runs.
    for (const cr of result.cycles) {
      expect(cr.guardrailBlocked).toBe(false);
    }
    // apply was called for the alice create entry.
    expect(cycle.applyCallCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Consistency check: pipeline.ts emitted flags parse cleanly
// ---------------------------------------------------------------------------

describe("pipeline.ts ↔ CLI flag consistency", () => {
  it("dry-run command flags from pipeline.ts parse without error", () => {
    // The emitted dry-run step in pipeline.ts runs:
    //   npx chant-governance reconcile \
    //     --config "<configPath>" \
    //     --token-env GH_TOKEN \
    //     --installation-id-env GOVERNANCE_INSTALLATION_ID \
    //     --mode dry-run[--cycles ...]
    //
    // We parse the same flags here to prove the CLI accepts them.
    const flags = [
      "--config",
      ".github/governance.yml",
      "--token-env",
      "GH_TOKEN",
      "--installation-id-env",
      "GOVERNANCE_INSTALLATION_ID",
      "--mode",
      "dry-run",
    ];
    expect(() => parseReconcileArgs(flags)).not.toThrow();

    const args = parseReconcileArgs(flags);
    expect(args.config).toBe(".github/governance.yml");
    expect(args.tokenEnv).toBe("GH_TOKEN");
    expect(args.installationIdEnv).toBe("GOVERNANCE_INSTALLATION_ID");
    expect(args.mode).toBe("dry-run");
  });

  it("apply command flags from pipeline.ts parse without error", () => {
    // The emitted apply step in pipeline.ts runs:
    //   npx chant-governance reconcile \
    //     --config "<configPath>" \
    //     --token-env GH_TOKEN \
    //     --installation-id-env GOVERNANCE_INSTALLATION_ID \
    //     --mode apply[--cycles ...]
    const flags = [
      "--config",
      ".github/governance.yml",
      "--token-env",
      "GH_TOKEN",
      "--installation-id-env",
      "GOVERNANCE_INSTALLATION_ID",
      "--mode",
      "apply",
    ];
    expect(() => parseReconcileArgs(flags)).not.toThrow();

    const args = parseReconcileArgs(flags);
    expect(args.mode).toBe("apply");
  });

  it("pipeline cycles flag forwarding parses correctly", () => {
    // When cycles are specified: --cycles branch-protection,team-sync
    const flags = [
      "--config",
      ".github/governance.yml",
      "--token-env",
      "GH_TOKEN",
      "--installation-id-env",
      "GOVERNANCE_INSTALLATION_ID",
      "--mode",
      "dry-run",
      "--cycles",
      "branch-protection",
    ];
    const args = parseReconcileArgs(flags);
    expect(args.cycles).toEqual(["branch-protection"]);
  });
});
