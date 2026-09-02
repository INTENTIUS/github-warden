/**
 * Permission-gated (403) read tolerance — the uniform cross-warden behavior.
 *
 * A 403 on a declared slice's read never errors the cycle: the slice is
 * skipped (nothing live) and the runner appends a NOTE line to that cycle's
 * plan. These tests exercise the notes collector directly plus two of the
 * previously-intolerant cycles (org-settings, membership) end-to-end through
 * `runReconcile`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { drainNotes, notePermissionGated, isForbidden, isNotFound } from "./notes.js";
import { orgSettingsCycle } from "./org-settings.js";
import { membershipCycle } from "./membership.js";
import { teamsCycle } from "./teams.js";
import { runReconcile } from "../reconcile/runner.js";
import type { Cycle } from "../reconcile/runner.js";
import type { AppClient } from "../auth/app-client.js";
import { AppAuthError } from "../auth/app-client.js";

/** A client whose every request fails with the given error. */
function failingClient(err: Error): AppClient {
  return {
    async request(): Promise<never> {
      throw err;
    },
  };
}

const forbidden = () => new Error("GET /orgs/test-org returned 403: {\"message\":\"Forbidden\"}");

beforeEach(() => {
  // Never let notes from a failed test leak into the next.
  drainNotes();
});

describe("notes collector", () => {
  it("formats the shared NOTE wording and drains destructively", () => {
    notePermissionGated("membership", "test-org", "members");
    const notes = drainNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({
      cycle: "membership",
      org: "test-org",
      note: "NOTE: members: read was permission-gated (403); planned entries may fail on apply",
    });
    expect(drainNotes()).toHaveLength(0);
  });

  it("isForbidden / isNotFound recognise message-embedded and structured statuses", () => {
    expect(isForbidden(forbidden())).toBe(true);
    expect(isForbidden(new AppAuthError("nope", 403))).toBe(true);
    expect(isForbidden(new Error("GET /x returned 404"))).toBe(false);
    expect(isNotFound(new Error("GET /x returned 404"))).toBe(true);
    expect(isNotFound(new AppAuthError("gone", 404))).toBe(true);
    expect(isNotFound(forbidden())).toBe(false);
  });
});

describe("org-settings — 403 read tolerated (previously an errored cycle)", () => {
  it("plans the declared settings as a create with a NOTE instead of erroring", async () => {
    const result = await runReconcile({
      config: {
        orgs: { "test-org": { settings: { description: "declared" } } },
      },
      client: failingClient(forbidden()),
      cycles: [orgSettingsCycle as Cycle<unknown>],
    });

    // Not an errored cycle — the run completes.
    expect(result.errored).toHaveLength(0);
    expect(result.completed).toBe(true);

    const cr = result.cycles[0]!;
    expect(cr.counts.create).toBe(1);
    expect(cr.plan).toContain("[org-settings]");
    expect(cr.plan).toContain(
      "NOTE: org-settings: read was permission-gated (403); planned entries may fail on apply",
    );
  });

  it("a 404 stays silently empty (no NOTE)", async () => {
    const result = await runReconcile({
      config: { orgs: { "test-org": { settings: { description: "declared" } } } },
      client: failingClient(new Error("GET /orgs/test-org returned 404")),
      cycles: [orgSettingsCycle as Cycle<unknown>],
    });
    expect(result.errored).toHaveLength(0);
    expect(result.cycles[0]!.plan).not.toContain("NOTE:");
  });
});

describe("membership — 403 read tolerated (previously an errored cycle)", () => {
  it("plans declared members as creates with a NOTE instead of erroring", async () => {
    const result = await runReconcile({
      config: {
        orgs: {
          "test-org": {
            members: [
              { login: "alice", role: "admin" },
              { login: "bob", role: "member" },
            ],
          },
        },
      },
      client: failingClient(forbidden()),
      cycles: [membershipCycle as Cycle<unknown>],
    });

    expect(result.errored).toHaveLength(0);
    const cr = result.cycles[0]!;
    expect(cr.counts.create).toBe(2);
    expect(cr.plan).toContain("[member] alice");
    expect(cr.plan).toContain(
      "NOTE: members: read was permission-gated (403); planned entries may fail on apply",
    );
  });

  it("a non-403/404 error still surfaces as an errored cycle", async () => {
    const result = await runReconcile({
      config: { orgs: { "test-org": { members: [{ login: "alice" }] } } },
      client: failingClient(new Error("GET /orgs/test-org/members returned 500")),
      cycles: [membershipCycle as Cycle<unknown>],
    });
    expect(result.errored).toHaveLength(1);
    expect(result.errored[0]!.error).toContain("500");
  });
});

describe("teams — 403 on the team list tolerated", () => {
  it("plans declared teams as creates with a NOTE", async () => {
    const result = await runReconcile({
      config: { orgs: { "test-org": { teams: { backend: { description: "be" } } } } },
      client: failingClient(forbidden()),
      cycles: [teamsCycle as Cycle<unknown>],
      scope: {},
    });

    expect(result.errored).toHaveLength(0);
    const cr = result.cycles[0]!;
    expect(cr.counts.create).toBe(1);
    expect(cr.plan).toContain("[team] backend");
    expect(cr.plan).toContain(
      "NOTE: teams: read was permission-gated (403); planned entries may fail on apply",
    );
  });
});
