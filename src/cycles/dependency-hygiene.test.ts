/**
 * Tests for the dependency-hygiene cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: keeps repos that declare dependabot
 *   - fetchDependabot: base64 decode + sha; 404 → empty
 *   - diff over the cycle: create (absent) / update (content differs) / no-op
 *   - apply: PUT create (no sha) / PUT update (with sha) / missing-sha error
 *   - runner integration: dry-run plan
 */

import { describe, it, expect } from "vitest";
import { dependencyHygieneCycle, fetchDependabot } from "./dependency-hygiene.js";
import type { DependencyHygieneScope } from "./dependency-hygiene.js";
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

const scope: DependencyHygieneScope = {};
const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
const YML = 'version: 2\nupdates:\n  - package-ecosystem: "npm"\n';

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("dependencyHygieneCycle.buildDesired", () => {
  it("keeps only repos that declare dependabot", () => {
    const orgConfig: OrgConfig = {
      repos: {
        svc: { dependabot: { content: YML }, description: "x" },
        bare: { description: "no dependabot" },
      },
    };
    const desired = dependencyHygieneCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired.repos!["svc"]).toEqual({ dependabot: { content: YML } });
    expect(desired.repos).not.toHaveProperty("bare");
  });
});

// ---------------------------------------------------------------------------
// 2. fetchDependabot
// ---------------------------------------------------------------------------

describe("fetchDependabot", () => {
  it("decodes base64 content and captures the sha", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/svc/contents/.github/dependabot.yml": {
        content: b64(YML),
        encoding: "base64",
        sha: "abc123",
      },
    });
    const live = await fetchDependabot(client, "test-org", "svc", makeBudget());
    expect(live.content).toBe(YML);
    expect(live.sha).toBe("abc123");
  });

  it("returns empty on a 404", async () => {
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string): Promise<T> => {
      client.calls.push({ method, path });
      throw new Error("GET ... returned 404: Not Found");
    };
    expect(await fetchDependabot(client, "test-org", "ghost", makeBudget())).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. diff over the cycle
// ---------------------------------------------------------------------------

describe("diff integration with dependency-hygiene cycle", () => {
  const desiredConfig: OrgConfig = { repos: { svc: { dependabot: { content: YML } } } };

  it("emits create when the file is absent", () => {
    const desired = dependencyHygieneCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, { repos: { svc: { dependabot: {} } } });
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.resourceType).toBe("dependabot");
    expect(cs.entries[0]!.kind).toBe("create");
    expect(cs.entries[0]!.key).toBe("svc");
  });

  it("emits update when content differs (and carries the sha on before)", () => {
    const live: LiveOrgState = { repos: { svc: { dependabot: { content: "old", sha: "s1" } } } };
    const desired = dependencyHygieneCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, live);
    expect(cs.entries[0]!.kind).toBe("update");
    expect((cs.entries[0]!.before as { sha?: string }).sha).toBe("s1");
  });

  it("emits no entries when content matches", () => {
    const live: LiveOrgState = { repos: { svc: { dependabot: { content: YML, sha: "s1" } } } };
    const desired = dependencyHygieneCycle.buildDesired(desiredConfig, "test-org", scope);
    expect(diff("test-org", desired, live).entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. apply
// ---------------------------------------------------------------------------

describe("dependencyHygieneCycle.apply", () => {
  it("PUTs a create commit without a sha", async () => {
    const client = makeMockClient();
    await dependencyHygieneCycle.apply(
      client,
      { kind: "create", resourceType: "dependabot", key: "svc", after: { content: YML } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe("/repos/my-org/svc/contents/.github/dependabot.yml");
    const body = client.calls[0]!.body as Record<string, unknown>;
    expect(body.content).toBe(b64(YML));
    expect(body).not.toHaveProperty("sha");
  });

  it("PUTs an update commit with the live sha", async () => {
    const client = makeMockClient();
    await dependencyHygieneCycle.apply(
      client,
      {
        kind: "update",
        resourceType: "dependabot",
        key: "svc",
        before: { content: "old", sha: "s9" },
        after: { content: YML },
        fields: [],
      },
      "my-org",
      scope,
      makeBudget(),
    );
    const body = client.calls[0]!.body as Record<string, unknown>;
    expect(body.sha).toBe("s9");
    expect(body.content).toBe(b64(YML));
  });

  it("errors when an update is missing the live sha", async () => {
    const client = makeMockClient();
    await expect(
      dependencyHygieneCycle.apply(
        client,
        { kind: "update", resourceType: "dependabot", key: "svc", after: { content: YML }, fields: [] },
        "my-org",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow("missing the live file sha");
  });

  it("ignores foreign resource types", async () => {
    const client = makeMockClient();
    await dependencyHygieneCycle.apply(
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
// 5. Runner integration
// ---------------------------------------------------------------------------

describe("dependencyHygieneCycle via runReconcile", () => {
  it("dry-run: reports a create plan when the file is missing", async () => {
    const config: GovernanceConfig = {
      orgs: { "test-org": { repos: { svc: { dependabot: { content: YML } } } } },
    };
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
      client.calls.push({ method, path, body });
      if (method === "GET" && path.includes("/contents/")) {
        throw new Error("GET ... returned 404: Not Found");
      }
      return {} as T;
    };
    const result = await runReconcile({
      config,
      client,
      cycles: [dependencyHygieneCycle],
      scope: { repos: config.orgs["test-org"]!.repos } satisfies DependencyHygieneScope,
      mode: "dry-run",
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
