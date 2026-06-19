/**
 * Tests for the posture-audit engine and CLI subcommand.
 *
 * All tests are offline: a `fixtureFetch` intercepts GitHub API calls and
 * serves an in-memory file set that exercises the github lexicon (warden audits
 * GitHub posture only).
 */

import { describe, it, expect } from "vitest";
import { auditRepos, type PostureReport } from "./engine.js";
import { renderPostureSummary, shouldFail, type FailOn } from "./summary.js";
import { parseAuditArgs, CliError } from "../cli.js";

// ---------------------------------------------------------------------------
// Fixture fetch (same pattern as blacklight's fixture.ts)
// ---------------------------------------------------------------------------

/** A GitHub workflow that fires GHA013 (write-all permissions) and GHA037 (expression injection). */
const FIXTURE_FILES: Record<string, string> = {
  ".github/workflows/ci.yml": [
    "on: push",
    "permissions: write-all",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: echo ${{ github.event.issue.title }}",
  ].join("\n") + "\n",
};

/** Produce a GitHub-shaped mock fetch serving the given file set. */
function fixtureFetch(files: Record<string, string> = FIXTURE_FILES): typeof fetch {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
  return (async (input: string | URL | Request) => {
    const u = String(input);
    if (u.includes("/git/trees/")) {
      const tree = Object.keys(files).map((path) => ({ path, type: "blob", size: files[path].length }));
      return new Response(JSON.stringify({ tree }), { status: 200 });
    }
    const cm = u.match(/\/contents\/(.+?)\?/);
    if (cm) {
      const path = decodeURIComponent(cm[1]);
      if (files[path] === undefined) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({ path, type: "file", content: b64(files[path]), encoding: "base64" }),
        { status: 200 },
      );
    }
    if (/\/repos\/[^/]+\/[^/]+(\?|$)/.test(u))
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// auditRepos
// ---------------------------------------------------------------------------

describe("auditRepos", () => {
  it("produces a report with findings for the fixture repo", async () => {
    const report = await auditRepos(
      ["https://github.com/intentius/test-repo"],
      undefined, // no token needed for fixture fetch
      { fetchImpl: fixtureFetch() },
    );

    expect(report.repos).toHaveLength(1);
    const [r] = report.repos;
    expect(r.slug).toBe("intentius/test-repo");
    expect(r.error).toBeUndefined();
    expect(r.scanned).toBeGreaterThan(0);
    // The fixture has at least one finding (GHA013: write-all).
    expect(r.model.counts.total).toBeGreaterThan(0);
  });

  it("aggregates totals across multiple repos", async () => {
    // Two calls to the same fixture URL — two repo results.
    const report = await auditRepos(
      [
        "https://github.com/intentius/repo-a",
        "https://github.com/intentius/repo-b",
      ],
      undefined,
      { fetchImpl: fixtureFetch() },
    );

    expect(report.repos).toHaveLength(2);
    expect(report.totals.total).toBe(
      report.repos.reduce((s, r) => s + r.model.counts.total, 0),
    );
  });

  it("records an error for an unreachable repo (network error) without aborting", async () => {
    const failFetch: typeof fetch = () => Promise.reject(new Error("network error"));

    const report = await auditRepos(
      ["https://github.com/intentius/private-broken"],
      undefined,
      { fetchImpl: failFetch },
    );

    expect(report.repos).toHaveLength(1);
    expect(report.repos[0].error).toBeDefined();
    expect(report.totals.total).toBe(0);
  });

  it("passes the token through fetchImpl (private-repo path)", async () => {
    const seenTokens: string[] = [];
    const tokenCaptureFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      if (auth) seenTokens.push(auth);
      // Fall through to real fixture logic for the rest.
      return fixtureFetch()(input, init);
    }) as typeof fetch;

    await auditRepos(
      ["https://github.com/intentius/private-repo"],
      "ghp_testtoken",
      { fetchImpl: tokenCaptureFetch },
    );

    // At least one request should have carried the token.
    expect(seenTokens.some((h) => h.includes("ghp_testtoken"))).toBe(true);
  });

  it("handles an empty repo (no auditable files) without error", async () => {
    const emptyFetch = fixtureFetch({});
    const report = await auditRepos(
      ["https://github.com/intentius/empty-repo"],
      undefined,
      { fetchImpl: emptyFetch },
    );

    expect(report.repos[0].error).toBeUndefined();
    expect(report.repos[0].model.counts.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shouldFail
// ---------------------------------------------------------------------------

describe("shouldFail", () => {
  function makeReport(quickWin: number, needsReview: number, reportOnly: number): PostureReport {
    return {
      repos: [],
      totals: { quickWin, needsReview, reportOnly, total: quickWin + needsReview + reportOnly },
    };
  }

  it("never fails when failOn=none", () => {
    expect(shouldFail(makeReport(10, 5, 3), "none")).toBe(false);
  });

  it("fails on merge-worthy when quickWin > 0", () => {
    expect(shouldFail(makeReport(1, 0, 5), "merge-worthy")).toBe(true);
  });

  it("fails on merge-worthy when needsReview > 0", () => {
    expect(shouldFail(makeReport(0, 1, 5), "merge-worthy")).toBe(true);
  });

  it("does not fail on merge-worthy for report-only findings", () => {
    expect(shouldFail(makeReport(0, 0, 10), "merge-worthy")).toBe(false);
  });

  it("fails on any when only report-only findings exist", () => {
    expect(shouldFail(makeReport(0, 0, 1), "any")).toBe(true);
  });

  it("does not fail on any when total is 0", () => {
    expect(shouldFail(makeReport(0, 0, 0), "any")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderPostureSummary
// ---------------------------------------------------------------------------

describe("renderPostureSummary", () => {
  it("includes repo slug and finding counts", () => {
    const report: PostureReport = {
      repos: [
        {
          repoUrl: "https://github.com/intentius/test",
          slug: "intentius/test",
          scanned: 3,
          model: {
            counts: { total: 2, quickWin: 1, needsReview: 1, reportOnly: 0, errors: 1, warnings: 1, infos: 0, byCategory: {} },
            quickWins: [],
            needsReview: [],
            reportOnly: [],
          },
        },
      ],
      totals: { total: 2, quickWin: 1, needsReview: 1, reportOnly: 0 },
    };

    const out = renderPostureSummary(report);
    expect(out).toContain("intentius/test");
    expect(out).toContain("total=2");
    expect(out).toContain("quick-win=1");
    expect(out).toContain("scanned=3");
  });

  it("shows ERROR for repos that failed to fetch", () => {
    const report: PostureReport = {
      repos: [
        {
          repoUrl: "https://github.com/intentius/bad",
          slug: "intentius/bad",
          scanned: 0,
          model: {},
          error: "network timeout",
        },
      ],
      totals: { total: 0, quickWin: 0, needsReview: 0, reportOnly: 0 },
    };

    const out = renderPostureSummary(report);
    expect(out).toContain("ERROR");
    expect(out).toContain("network timeout");
  });
});

// ---------------------------------------------------------------------------
// parseAuditArgs
// ---------------------------------------------------------------------------

describe("parseAuditArgs", () => {
  it("parses valid token-env invocation", () => {
    const args = parseAuditArgs(["--config", "governance.yml", "--token-env", "GH_TOKEN"]);
    expect(args.config).toBe("governance.yml");
    expect(args.tokenEnv).toBe("GH_TOKEN");
    expect(args.failOn).toBe("none");
  });

  it("parses --fail-on merge-worthy", () => {
    const args = parseAuditArgs([
      "--config", "g.yml",
      "--token-env", "GH_TOKEN",
      "--fail-on", "merge-worthy",
    ]);
    expect(args.failOn).toBe("merge-worthy");
  });

  it("parses --fail-on any", () => {
    const args = parseAuditArgs([
      "--config", "g.yml",
      "--token-env", "GH_TOKEN",
      "--fail-on", "any",
    ]);
    expect(args.failOn).toBe("any");
  });

  it("parses app-id + installation-id auth", () => {
    const args = parseAuditArgs([
      "--config", "g.yml",
      "--app-id-env", "APP_ID",
      "--installation-id-env", "INSTALL_ID",
    ]);
    expect(args.appIdEnv).toBe("APP_ID");
    expect(args.installationIdEnv).toBe("INSTALL_ID");
    expect(args.tokenEnv).toBeUndefined();
  });

  it("throws code 2 when --config is missing", () => {
    expect(() => parseAuditArgs(["--token-env", "GH_TOKEN"])).toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });

  it("throws code 2 when no auth is supplied", () => {
    expect(() => parseAuditArgs(["--config", "g.yml"])).toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });

  it("throws code 2 for an invalid --fail-on value", () => {
    expect(() =>
      parseAuditArgs(["--config", "g.yml", "--token-env", "GH_TOKEN", "--fail-on", "bad"]),
    ).toThrow(expect.objectContaining({ code: 2 }));
  });

  it("throws code 2 for an unknown flag", () => {
    expect(() =>
      parseAuditArgs(["--config", "g.yml", "--token-env", "GH_TOKEN", "--unknown"]),
    ).toThrow(expect.objectContaining({ code: 2 }));
  });
});
