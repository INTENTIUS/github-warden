/**
 * End-to-end harness — exercises warden's cycles against a REAL GitHub org via
 * a real GitHub App installation. Gated and excluded from the default test run
 * (`vitest.config.ts` only globs `src/**`); run with `npm run test:e2e`.
 *
 * The whole suite SKIPS unless these env vars are set, so default CI and
 * contributors without a test org are unaffected:
 *
 *   WARDEN_E2E_APP_ID            GitHub App id
 *   WARDEN_E2E_INSTALLATION_ID   installation id on the test org
 *   WARDEN_E2E_PRIVATE_KEY       App private key PEM
 *   WARDEN_E2E_ORG               test org login
 *   WARDEN_E2E_APPLY=1           (optional) also run the mutating Phase 2
 *
 * ## Phase 1 — read-only contract checks (always, when configured)
 * For every registered cycle: run `fetchLive` against the real org, then
 * `buildDesired` + `diff`, and assert (a) every HTTP call was a GET — fetchLive
 * never mutates — and (b) the pipeline composes into a valid change set. This
 * is what catches GitHub API-contract drift (renamed fields, moved paths,
 * permission changes), especially for the App-only token cycles that mocks
 * can't validate.
 *
 * ## Phase 2 — one teardown-guarded mutation (only with WARDEN_E2E_APPLY=1)
 * A single self-cleaning round-trip (create then delete a repo Actions
 * variable) to prove the apply/write path works against real GitHub.
 */

import { describe, it, beforeAll, expect } from "vitest";
import { createAppClient, type AppClient } from "../src/auth/app-client.js";
import { CYCLE_REGISTRY } from "../src/cli/registry.js";
import { diff } from "../src/reconcile/diff.js";
import type { RateBudget } from "../src/reconcile/runner.js";
import type { OrgConfig, RepoConfig } from "../src/config/types.js";

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

const ENV = process.env;
const APP_ID = ENV.WARDEN_E2E_APP_ID;
const INSTALLATION_ID = ENV.WARDEN_E2E_INSTALLATION_ID;
const PRIVATE_KEY = ENV.WARDEN_E2E_PRIVATE_KEY?.replace(/\\n/g, "\n");
const ORG = ENV.WARDEN_E2E_ORG;
const APPLY = ENV.WARDEN_E2E_APPLY === "1";

const configured = Boolean(APP_ID && INSTALLATION_ID && PRIVATE_KEY && ORG);
const suite = configured ? describe : describe.skip;

if (!configured) {
  // eslint-disable-next-line no-console
  console.warn(
    "[e2e] skipped — set WARDEN_E2E_APP_ID / _INSTALLATION_ID / _PRIVATE_KEY / _ORG to run.",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

interface Call {
  method: string;
  path: string;
}

/** Wrap a client to record every (method, path) it is asked to perform. */
function recording(inner: AppClient): { client: AppClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        calls.push({ method, path });
        return inner.request<T>(method, path, body);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("warden e2e (real GitHub org)", () => {
  let client: AppClient;
  let scope: { repos: Record<string, RepoConfig> };
  let orgConfig: OrgConfig;

  beforeAll(async () => {
    client = createAppClient({
      appId: APP_ID!,
      installationId: INSTALLATION_ID!,
      privateKeyPem: PRIVATE_KEY!,
    });

    // Discover a few repos so repo-scoped cycles have something to fetch.
    const repos = await client.request<Array<{ name: string }>>(
      "GET",
      `/orgs/${ORG}/repos?per_page=3&type=all`,
    );
    const repoNames = (repos ?? []).map((r) => r.name).slice(0, 3);

    // A "kitchen-sink" repo config so every repo-scoped cycle's fetchLive
    // actually hits its endpoints (all reads tolerate 404 for absent resources).
    const repoCfg: RepoConfig = {
      branchProtection: [{ pattern: "main" }],
      security: { secretScanning: true },
      environments: [{ name: "production" }],
      rulesets: [{ name: "warden-e2e-probe" }],
      secrets: [{ name: "WARDEN_E2E_PROBE" }],
      variables: [{ name: "WARDEN_E2E_PROBE" }],
      dependabot: { content: "version: 2\nupdates: []\n" },
      description: "warden e2e (not written in Phase 1)",
    };

    const repoMap: Record<string, RepoConfig> = {};
    for (const n of repoNames) repoMap[n] = { ...repoCfg };

    scope = { repos: repoMap };
    orgConfig = {
      settings: {},
      rulesets: [],
      tokenPolicy: { revokeExpired: true },
      tokenApproval: { default: "manual" },
      repos: repoMap,
    };
  }, 60_000);

  // ── Phase 1: every cycle's read path is contract-valid and read-only ──────

  for (const cycle of Object.values(CYCLE_REGISTRY)) {
    it(`${cycle.name}: fetchLive is read-only and diffs cleanly`, async () => {
      const rec = recording(client);
      const budget = makeBudget();

      const live = await cycle.fetchLive(rec.client, ORG!, scope, budget);
      const desired = cycle.buildDesired(orgConfig, ORG!, scope);
      const changeSet = diff(ORG!, desired, live, {});

      // fetchLive must never mutate — every call it made is a GET.
      const nonGet = rec.calls.filter((c) => c.method !== "GET");
      expect(nonGet, `non-GET calls from ${cycle.name}.fetchLive`).toEqual([]);

      // The pipeline composed into a valid change set.
      expect(Array.isArray(changeSet.entries)).toBe(true);
    }, 60_000);
  }

  // ── Phase 2: one teardown-guarded mutation (opt-in) ───────────────────────

  (APPLY ? it : it.skip)(
    "apply round-trip: create + delete a repo Actions variable",
    async () => {
      const repo = Object.keys(scope.repos)[0];
      expect(repo, "need at least one discovered repo").toBeTruthy();
      const base = `/repos/${ORG}/${repo}/actions/variables`;
      const name = "WARDEN_E2E_PROBE";

      try {
        await client.request("POST", base, { name, value: "ok" });
        const got = await client.request<{ name: string; value: string }>("GET", `${base}/${name}`);
        expect(got.value).toBe("ok");
      } finally {
        // Always clean up, even if an assertion above failed.
        await client.request("DELETE", `${base}/${name}`).catch(() => undefined);
      }
    },
    60_000,
  );
});
