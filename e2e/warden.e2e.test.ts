/**
 * End-to-end harness — exercises warden's cycles against a REAL GitHub org via
 * a real GitHub App installation. Gated and excluded from the default test run
 * (`vitest.config.ts` only globs `src/**`); run with `npm run test:e2e`.
 *
 * ## Hermetic / self-provisioning
 * The suite CREATES its own throwaway resources and deletes them afterward — it
 * does not rely on anything pre-existing in the org:
 *   - a fresh repo `warden-e2e-<run>` (auto-initialised so `main` exists)
 *   - one Actions variable and one Actions secret (sealed-box encrypted) on it
 * Teardown deletes the repo, which removes its secrets/variables with it.
 *
 * ## Gating
 * Skips entirely unless these env vars are set, so default CI and contributors
 * without a test org are unaffected:
 *   WARDEN_E2E_APP_ID  WARDEN_E2E_INSTALLATION_ID  WARDEN_E2E_PRIVATE_KEY
 *   WARDEN_E2E_ORG     WARDEN_E2E_APPLY=1 (optional, enables the mutating phase)
 *
 * ## Required App permissions (on the test org installation)
 * Repository administration: read+write (create/delete repos), Actions secrets
 * + variables: read+write, plus the read scopes the cycles touch (contents,
 * administration, members, organization administration). Deleting repos needs
 * the App to allow it.
 *
 * ## Phases
 *   1 (always): per cycle, fetchLive + diff against the provisioned repo/org,
 *     asserting every HTTP call was a GET and the change set composes — catches
 *     live API-contract drift (esp. the App-only token cycles).
 *   2 (WARDEN_E2E_APPLY=1): one apply through a cycle (set a repo topic),
 *     verified by re-fetch; cleaned up by the repo teardown.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import _sodium from "libsodium-wrappers";
import { createAppClient, type AppClient } from "../src/auth/app-client.js";
import { CYCLE_REGISTRY } from "../src/cli/registry.js";
import { repoSettingsCycle } from "../src/cycles/repo-settings.js";
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

const REPO = `warden-e2e-${ENV.GITHUB_RUN_ID ?? Date.now()}`;

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

/** Create a repo Actions secret (sealed-box encrypted, as GitHub requires). */
async function createRepoSecret(
  client: AppClient,
  org: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  await _sodium.ready;
  const sodium = _sodium;
  const pk = await client.request<{ key: string; key_id: string }>(
    "GET",
    `/repos/${org}/${repo}/actions/secrets/public-key`,
  );
  const encrypted = sodium.to_base64(
    sodium.crypto_box_seal(
      sodium.from_string(value),
      sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL),
    ),
    sodium.base64_variants.ORIGINAL,
  );
  await client.request("PUT", `/repos/${org}/${repo}/actions/secrets/${name}`, {
    encrypted_value: encrypted,
    key_id: pk.key_id,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("warden e2e (real GitHub org)", () => {
  let client: AppClient;
  let scope: { repos: Record<string, RepoConfig> };
  let orgConfig: OrgConfig;
  let repoCreated = false;

  beforeAll(async () => {
    client = createAppClient({
      appId: APP_ID!,
      installationId: INSTALLATION_ID!,
      privateKeyPem: PRIVATE_KEY!,
    });

    // Provision a throwaway repo (auto_init gives it a `main` branch). Public so
    // that feature-gated capabilities (branch protection, rulesets, environments)
    // are available even on a free org — a private free repo 403s on those.
    await client.request("POST", `/orgs/${ORG}/repos`, {
      name: REPO,
      private: false,
      auto_init: true,
      description: "warden e2e — auto-created, safe to delete",
    });
    repoCreated = true;

    // Seed one variable and one (encrypted) secret so the secrets/variables
    // cycles read real data.
    await client.request("POST", `/repos/${ORG}/${REPO}/actions/variables`, {
      name: "WARDEN_E2E_VAR",
      value: "ok",
    });
    await createRepoSecret(client, ORG!, REPO, "WARDEN_E2E_SECRET", "ok");

    // "Kitchen-sink" repo config so every repo-scoped cycle's fetchLive hits
    // its endpoints (reads tolerate 404 for absent resources).
    const repoCfg: RepoConfig = {
      branchProtection: [{ pattern: "main" }],
      security: { secretScanning: true },
      environments: [{ name: "production" }],
      rulesets: [{ name: "warden-e2e-probe" }],
      secrets: [{ name: "WARDEN_E2E_SECRET" }],
      variables: [{ name: "WARDEN_E2E_VAR" }],
      dependabot: { content: "version: 2\nupdates: []\n" },
      description: "warden e2e",
    };

    scope = { repos: { [REPO]: repoCfg } };
    orgConfig = {
      settings: {},
      rulesets: [],
      tokenPolicy: { revokeExpired: true },
      tokenApproval: { default: "manual" },
      repos: { [REPO]: repoCfg },
    };
  }, 90_000);

  afterAll(async () => {
    // Best-effort teardown — delete the repo (removes its secrets/variables).
    if (repoCreated) {
      await client.request("DELETE", `/repos/${ORG}/${REPO}`).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[e2e] teardown: failed to delete ${ORG}/${REPO}:`, err);
      });
    }
  }, 60_000);

  // ── Phase 1: every cycle's read path is contract-valid and read-only ──────

  for (const cycle of Object.values(CYCLE_REGISTRY)) {
    it(`${cycle.name}: fetchLive is read-only and diffs cleanly`, async () => {
      const rec = recording(client);
      const budget = makeBudget();

      let live;
      try {
        live = await cycle.fetchLive(rec.client, ORG!, scope, budget);
      } catch (err) {
        // fetchLive only ever issues GETs — assert that even on the failure
        // path, then treat a 403 (the App lacks that permission, or the feature
        // is unavailable on the org's plan) as "not exercisable here" rather
        // than a failure. Keeps the harness robust to the App's permission
        // scope; the warning shows which cycles need broader grants.
        const nonGet = rec.calls.filter((c) => c.method !== "GET");
        expect(nonGet, `${cycle.name}.fetchLive made a non-GET before failing`).toEqual([]);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("403")) {
          // eslint-disable-next-line no-console
          console.warn(`[e2e] ${cycle.name}: skipped (403) — ${msg.slice(0, 140)}`);
          return;
        }
        throw err;
      }

      const desired = cycle.buildDesired(orgConfig, ORG!, scope);
      const changeSet = diff(ORG!, desired, live, {});

      const nonGet = rec.calls.filter((c) => c.method !== "GET");
      expect(nonGet, `non-GET calls from ${cycle.name}.fetchLive`).toEqual([]);
      expect(Array.isArray(changeSet.entries)).toBe(true);
    }, 60_000);
  }

  // ── Phase 2: one apply through a cycle (opt-in) ───────────────────────────

  (APPLY ? it : it.skip)(
    "apply: repo-settings sets a topic, verified by re-fetch",
    async () => {
      await repoSettingsCycle.apply(
        client,
        { kind: "update", resourceType: "repo", key: REPO, after: { topics: ["warden-e2e"] } },
        ORG!,
        {},
        makeBudget(),
      );
      const got = await client.request<{ names: string[] }>(
        "GET",
        `/repos/${ORG}/${REPO}/topics`,
      );
      expect(got.names).toContain("warden-e2e");
    },
    60_000,
  );
});
