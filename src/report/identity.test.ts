/**
 * Tests for the identity & service-account hygiene report.
 *
 * Pure unit tests over mock inputs — no network.
 */

import { describe, it, expect } from "vitest";
import { buildIdentityReport, renderIdentityReport } from "./identity.js";

describe("buildIdentityReport", () => {
  it("inventories installed apps with permission counts", () => {
    const report = buildIdentityReport(
      [
        { app_slug: "dependabot", app_id: 1, permissions: { contents: "read", metadata: "read" } },
        { app_slug: "warden", app_id: 2, permissions: {} },
      ],
      [],
      [],
    );
    expect(report.installations.count).toBe(2);
    expect(report.installations.apps[0]).toEqual({ slug: "dependabot", appId: 1, permissionCount: 2 });
    expect(report.installations.apps[1]!.permissionCount).toBe(0);
  });

  it("flags declared machine users that are org members and recommends Apps", () => {
    const report = buildIdentityReport(
      [],
      ["alice", "ci-bot", "deploy-bot"],
      ["ci-bot", "deploy-bot", "retired-bot"],
    );
    expect(report.machineUsers.flagged).toEqual(["ci-bot", "deploy-bot"]);
    expect(report.machineUsers.notMembers).toEqual(["retired-bot"]);
    expect(report.summary.flaggedMachineUsers).toBe(2);
    expect(report.recommendations).toHaveLength(2);
    expect(report.recommendations[0]).toContain("ci-bot");
    expect(report.recommendations[0]).toContain("Apps consume no seat");
  });

  it("de-dupes declared machine users", () => {
    const report = buildIdentityReport([], ["bot"], ["bot", "bot"]);
    expect(report.machineUsers.flagged).toEqual(["bot"]);
  });

  it("defaults a missing app slug to 'unknown'", () => {
    const report = buildIdentityReport([{ app_id: 9 }], [], []);
    expect(report.installations.apps[0]!.slug).toBe("unknown");
  });
});

describe("renderIdentityReport", () => {
  it("renders apps and flagged machine users", () => {
    const out = renderIdentityReport(
      buildIdentityReport(
        [{ app_slug: "warden", app_id: 1, permissions: { contents: "write" } }],
        ["ci-bot"],
        ["ci-bot"],
      ),
    );
    expect(out).toContain("identity & service-account hygiene");
    expect(out).toContain("installed apps: 1");
    expect(out).toContain("warden  permissions=1");
    expect(out).toContain("1 flagged");
    expect(out).toContain("⚠");
  });
});
