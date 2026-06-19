import { describe, it, expect } from "vitest";
import {
  resolveRenames,
  removalDeltaCap,
  adminFloor,
  requiredAdmins,
  requireSelf,
  runGuardrails,
} from "./guardrails.js";
import type { ChangeSet } from "./diff.js";
import type { LiveOrgState } from "./diff.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChangeSet(entries: ChangeSet["entries"]): ChangeSet {
  return { org: "test-org", entries };
}

function emptyLive(): LiveOrgState {
  return {};
}

function liveWithAdmins(logins: string[]): LiveOrgState {
  return {
    members: logins.map((login) => ({ login, role: "admin" as const })),
  };
}

function liveWithMembers(
  members: Array<{ login: string; role: "admin" | "member" }>,
): LiveOrgState {
  return { members };
}

// ---------------------------------------------------------------------------
// resolveRenames
// ---------------------------------------------------------------------------

describe("resolveRenames", () => {
  it("passes through a change set with no renames", () => {
    const cs = makeChangeSet([
      { kind: "create", resourceType: "member", key: "alice", after: { login: "alice", role: "member" } },
      { kind: "delete", resourceType: "member", key: "bob", before: { login: "bob", role: "member" } },
    ]);
    const result = resolveRenames(cs);
    expect(result.entries).toHaveLength(2);
  });

  it("collapses delete+create into update when previously alias matches", () => {
    const cs = makeChangeSet([
      {
        kind: "delete",
        resourceType: "member",
        key: "old-alice",
        before: { login: "old-alice", role: "admin" },
      },
      {
        kind: "create",
        resourceType: "member",
        key: "alice",
        after: { login: "alice", role: "admin", previously: "old-alice" },
      },
    ]);
    const result = resolveRenames(cs);
    expect(result.entries).toHaveLength(1);
    const e = result.entries[0];
    expect(e.kind).toBe("update");
    expect(e.key).toBe("alice");
    expect(e.before).toMatchObject({ login: "old-alice" });
    expect(e.after).toMatchObject({ login: "alice" });
  });

  it("leaves unmatched deletes in place", () => {
    const cs = makeChangeSet([
      {
        kind: "delete",
        resourceType: "member",
        key: "unrelated",
        before: { login: "unrelated", role: "member" },
      },
      {
        kind: "create",
        resourceType: "member",
        key: "alice",
        after: { login: "alice", role: "admin", previously: "old-alice" },
      },
    ]);
    const result = resolveRenames(cs);
    // unrelated delete remains; create without matching delete also remains
    expect(result.entries).toHaveLength(2);
    expect(result.entries.some((e) => e.kind === "delete" && e.key === "unrelated")).toBe(true);
    expect(result.entries.some((e) => e.kind === "create" && e.key === "alice")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removalDeltaCap
// ---------------------------------------------------------------------------

describe("removalDeltaCap", () => {
  it("passes when deletions are within the threshold", () => {
    // 1 delete out of 10 total = 10%, threshold 25%
    const cs = makeChangeSet([
      { kind: "delete", resourceType: "member", key: "a", before: {} },
      ...Array.from({ length: 9 }, (_, i) => ({
        kind: "update" as const,
        resourceType: "member",
        key: `m${i}`,
        before: {},
        after: {},
      })),
    ]);
    expect(removalDeltaCap(cs)).toBeNull();
  });

  it("trips when deletions exceed the threshold", () => {
    // 6 deletes out of 8 total = 75%, threshold 25%
    const cs = makeChangeSet([
      ...Array.from({ length: 6 }, (_, i) => ({
        kind: "delete" as const,
        resourceType: "member",
        key: `d${i}`,
        before: {},
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        kind: "update" as const,
        resourceType: "member",
        key: `u${i}`,
        before: {},
        after: {},
      })),
    ]);
    const result = removalDeltaCap(cs);
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("removalDeltaCap");
    expect(result!.message).toMatch(/75%/);
  });

  it("respects a custom maxFraction", () => {
    // 3 deletes out of 4 total = 75%, threshold 80% → should pass
    const cs = makeChangeSet([
      ...Array.from({ length: 3 }, (_, i) => ({
        kind: "delete" as const,
        resourceType: "member",
        key: `d${i}`,
        before: {},
      })),
      { kind: "update", resourceType: "member", key: "u0", before: {}, after: {} },
    ]);
    expect(removalDeltaCap(cs, { maxFraction: 0.8 })).toBeNull();
  });

  it("returns null for an empty change set", () => {
    expect(removalDeltaCap(makeChangeSet([]))).toBeNull();
  });

  it("trips when deletes are diluted by many creates", () => {
    // 5 deletes + 100 creates. If creates were in the denominator, the fraction
    // would be 5/105 ≈ 4.7% and pass a 25% cap. Excluding creates, the only
    // pre-existing entries are the 5 deletes → 100% → must TRIP.
    const cs = makeChangeSet([
      ...Array.from({ length: 5 }, (_, i) => ({
        kind: "delete" as const,
        resourceType: "member",
        key: `d${i}`,
        before: { login: `d${i}`, role: "member" },
      })),
      ...Array.from({ length: 100 }, (_, i) => ({
        kind: "create" as const,
        resourceType: "member",
        key: `c${i}`,
        after: { login: `c${i}`, role: "member" },
      })),
    ]);
    const result = removalDeltaCap(cs);
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("removalDeltaCap");
  });

  it("does not count a resolved rename as a delete", () => {
    // Before rename resolution: 1 delete + 1 create (with previously alias).
    // After resolution: 1 update — delete fraction is 0%, should pass at any threshold.
    //
    // removalDeltaCap expects a pre-resolved ChangeSet (callers must call
    // resolveRenames first — the contract matches how runGuardrails uses it).
    const raw = makeChangeSet([
      {
        kind: "delete",
        resourceType: "member",
        key: "old-name",
        before: { login: "old-name", role: "admin" },
      },
      {
        kind: "create",
        resourceType: "member",
        key: "new-name",
        after: { login: "new-name", role: "admin", previously: "old-name" },
      },
    ]);
    const resolved = resolveRenames(raw);
    // With a very low threshold, should still pass because the delete is a rename
    expect(removalDeltaCap(resolved, { maxFraction: 0.01 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// adminFloor
// ---------------------------------------------------------------------------

describe("adminFloor", () => {
  it("passes when enough admins remain", () => {
    const cs = makeChangeSet([]);
    const live = liveWithAdmins(["alice", "bob", "carol"]);
    expect(adminFloor(cs, live)).toBeNull();
  });

  it("trips when a delete reduces admins below the floor", () => {
    // Live: alice + bob (2 admins). Delete bob → 1 admin, below default floor of 2.
    const cs = makeChangeSet([
      { kind: "delete", resourceType: "member", key: "bob", before: { login: "bob", role: "admin" } },
    ]);
    const live = liveWithAdmins(["alice", "bob"]);
    const result = adminFloor(cs, live);
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("adminFloor");
    expect(result!.message).toMatch(/1 org admin/);
  });

  it("trips when a role change demotes the last admin", () => {
    // Live: alice (admin). Update alice to member → 0 admins.
    const cs = makeChangeSet([
      {
        kind: "update",
        resourceType: "member",
        key: "alice",
        before: { login: "alice", role: "admin" },
        after: { login: "alice", role: "member" },
        fields: [{ field: "role", before: "admin", after: "member" }],
      },
    ]);
    const live = liveWithAdmins(["alice"]);
    const result = adminFloor(cs, live);
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("adminFloor");
  });

  it("passes when a new admin is added to compensate", () => {
    // Live: alice (admin). Delete alice, create carol as admin → still 1 admin.
    // Default min=2, but with min=1 it should pass.
    const cs = makeChangeSet([
      { kind: "delete", resourceType: "member", key: "alice", before: { login: "alice", role: "admin" } },
      { kind: "create", resourceType: "member", key: "carol", after: { login: "carol", role: "admin" } },
    ]);
    const live = liveWithAdmins(["alice"]);
    expect(adminFloor(cs, live, { min: 1 })).toBeNull();
  });

  it("trips when a rename removes the only other admin (ghost fix)", () => {
    // Live: alice + bob (2 admins). Rename bob → bob-new. The renamed admin must
    // not double-count: surviving admins are alice + bob-new = 2... but we also
    // delete alice, leaving only bob-new. Without the ghost fix, bob would also
    // linger as a surviving admin, masking the drop below the floor.
    const cs = makeChangeSet([
      {
        kind: "delete",
        resourceType: "member",
        key: "alice",
        before: { login: "alice", role: "admin" },
      },
      {
        kind: "delete",
        resourceType: "member",
        key: "bob",
        before: { login: "bob", role: "admin" },
      },
      {
        kind: "create",
        resourceType: "member",
        key: "bob-new",
        after: { login: "bob-new", role: "admin", previously: "bob" },
      },
    ]);
    const live = liveWithAdmins(["alice", "bob"]);
    // After resolution: delete alice, update bob→bob-new (admin). Surviving
    // admins = { bob-new } = 1, below default floor of 2 → TRIP.
    const result = adminFloor(cs, live);
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("adminFloor");
    expect(result!.message).toMatch(/1 org admin/);
  });

  it("respects a custom min", () => {
    // Live: 5 admins. Delete 4. 1 remains. min=1 → pass.
    const logins = ["a", "b", "c", "d", "e"];
    const cs = makeChangeSet(
      logins.slice(0, 4).map((l) => ({
        kind: "delete" as const,
        resourceType: "member",
        key: l,
        before: { login: l, role: "admin" },
      })),
    );
    const live = liveWithAdmins(logins);
    expect(adminFloor(cs, live, { min: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requiredAdmins
// ---------------------------------------------------------------------------

describe("requiredAdmins", () => {
  it("passes when all required admins remain", () => {
    const cs = makeChangeSet([]);
    const live = liveWithAdmins(["alice", "bob"]);
    expect(requiredAdmins(cs, live, { logins: ["alice"] })).toBeNull();
  });

  it("trips when a required admin is deleted", () => {
    const cs = makeChangeSet([
      { kind: "delete", resourceType: "member", key: "alice", before: { login: "alice", role: "admin" } },
    ]);
    const live = liveWithAdmins(["alice", "bob"]);
    const result = requiredAdmins(cs, live, { logins: ["alice"] });
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("requiredAdmins");
    expect(result!.message).toMatch(/alice/);
  });

  it("trips when a required admin is demoted to member", () => {
    const cs = makeChangeSet([
      {
        kind: "update",
        resourceType: "member",
        key: "alice",
        before: { login: "alice", role: "admin" },
        after: { login: "alice", role: "member" },
        fields: [{ field: "role", before: "admin", after: "member" }],
      },
    ]);
    const live = liveWithAdmins(["alice", "bob"]);
    const result = requiredAdmins(cs, live, { logins: ["alice"] });
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("requiredAdmins");
  });

  it("trips when a required admin is renamed away (ghost fix)", () => {
    // alice is required. Rename alice → alice-new. The required login "alice" no
    // longer survives. Without the ghost fix, alice would linger as a surviving
    // admin and this would fail-open.
    const cs = makeChangeSet([
      {
        kind: "delete",
        resourceType: "member",
        key: "alice",
        before: { login: "alice", role: "admin" },
      },
      {
        kind: "create",
        resourceType: "member",
        key: "alice-new",
        after: { login: "alice-new", role: "admin", previously: "alice" },
      },
    ]);
    const live = liveWithAdmins(["alice", "bob"]);
    const result = requiredAdmins(cs, live, { logins: ["alice"] });
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("requiredAdmins");
    expect(result!.message).toMatch(/alice/);
  });

  it("passes with an empty logins list", () => {
    const cs = makeChangeSet([
      { kind: "delete", resourceType: "member", key: "alice", before: { login: "alice", role: "admin" } },
    ]);
    const live = liveWithAdmins(["alice"]);
    expect(requiredAdmins(cs, live, { logins: [] })).toBeNull();
  });

  it("reports all missing required admins in one diagnostic", () => {
    const cs = makeChangeSet([
      { kind: "delete", resourceType: "member", key: "alice", before: { login: "alice", role: "admin" } },
      { kind: "delete", resourceType: "member", key: "bob", before: { login: "bob", role: "admin" } },
    ]);
    const live = liveWithAdmins(["alice", "bob", "carol"]);
    const result = requiredAdmins(cs, live, { logins: ["alice", "bob"] });
    expect(result).not.toBeNull();
    expect(result!.message).toMatch(/alice/);
    expect(result!.message).toMatch(/bob/);
  });
});

// ---------------------------------------------------------------------------
// requireSelf
// ---------------------------------------------------------------------------

describe("requireSelf", () => {
  it("passes when self login remains as a member", () => {
    const cs = makeChangeSet([]);
    const live = liveWithMembers([{ login: "bot", role: "admin" }]);
    expect(requireSelf(cs, live, { selfLogin: "bot" })).toBeNull();
  });

  it("trips when self login is deleted from the org", () => {
    const cs = makeChangeSet([
      { kind: "delete", resourceType: "member", key: "bot", before: { login: "bot", role: "admin" } },
    ]);
    const live = liveWithMembers([{ login: "bot", role: "admin" }]);
    const result = requireSelf(cs, live, { selfLogin: "bot" });
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("requireSelf");
    expect(result!.message).toMatch(/bot/);
  });

  it("trips when self login is demoted out of admin", () => {
    const cs = makeChangeSet([
      {
        kind: "update",
        resourceType: "member",
        key: "bot",
        before: { login: "bot", role: "admin" },
        after: { login: "bot", role: "member" },
        fields: [{ field: "role", before: "admin", after: "member" }],
      },
    ]);
    const live = liveWithMembers([{ login: "bot", role: "admin" }]);
    // requireSelf refuses membership loss AND admin demotion
    const result = requireSelf(cs, live, { selfLogin: "bot" });
    expect(result).not.toBeNull();
    expect(result!.guardrail).toBe("requireSelf");
  });

  it("trips when self does not exist in live and a delete is added", () => {
    // Edge case: self not in live at all, and a create+delete pair removes it
    const cs = makeChangeSet([
      { kind: "create", resourceType: "member", key: "bot", after: { login: "bot", role: "admin" } },
      { kind: "delete", resourceType: "member", key: "bot", before: { login: "bot", role: "admin" } },
    ]);
    const live = emptyLive();
    // Two entries for "bot": create then delete. Net result: deleted.
    // Our implementation processes entries in order, so role ends up null.
    const result = requireSelf(cs, live, { selfLogin: "bot" });
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runGuardrails — aggregate
// ---------------------------------------------------------------------------

describe("runGuardrails", () => {
  it("returns ok when no guardrails trip", () => {
    const cs = makeChangeSet([]);
    const live = liveWithAdmins(["alice", "bob"]);
    const result = runGuardrails(cs, live, {
      requireSelf: { selfLogin: "alice" },
      requiredAdmins: { logins: ["alice"] },
    });
    expect(result.ok).toBe(true);
  });

  it("aggregates all tripped guardrails in one result", () => {
    // Mass deletion (trips cap) + wipes self (trips requireSelf)
    const entries = Array.from({ length: 10 }, (_, i) => ({
      kind: "delete" as const,
      resourceType: "member",
      key: `user${i}`,
      before: { login: `user${i}`, role: "member" },
    }));
    // Also delete the self-login
    entries.push({
      kind: "delete" as const,
      resourceType: "member",
      key: "bot",
      before: { login: "bot", role: "admin" },
    });
    const cs = makeChangeSet(entries);
    const live: LiveOrgState = {
      members: [
        ...Array.from({ length: 10 }, (_, i) => ({ login: `user${i}`, role: "member" as const })),
        { login: "bot", role: "admin" as const },
      ],
    };

    const result = runGuardrails(cs, live, {
      requireSelf: { selfLogin: "bot" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const guardrailNames = result.diagnostics.map((d) => d.guardrail);
      // Should trip at least removalDeltaCap and requireSelf
      expect(guardrailNames).toContain("removalDeltaCap");
      expect(guardrailNames).toContain("requireSelf");
    }
  });

  it("reports an admin-floor trip caused by a rename plus a delete (ghost fix)", () => {
    // Live: alice + bob (2 admins). Rename bob → bob-new and delete alice.
    // Surviving admins = { bob-new } = 1, below the default floor of 2.
    // The ghost fix ensures bob is not double-counted, so the trip is reported.
    const cs = makeChangeSet([
      {
        kind: "delete",
        resourceType: "member",
        key: "alice",
        before: { login: "alice", role: "admin" },
      },
      {
        kind: "delete",
        resourceType: "member",
        key: "bob",
        before: { login: "bob", role: "admin" },
      },
      {
        kind: "create",
        resourceType: "member",
        key: "bob-new",
        after: { login: "bob-new", role: "admin", previously: "bob" },
      },
    ]);
    const live = liveWithAdmins(["alice", "bob"]);
    const result = runGuardrails(cs, live);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const names = result.diagnostics.map((d) => d.guardrail);
      expect(names).toContain("adminFloor");
    }
  });

  it("runs with no config (only default-threshold guardrails)", () => {
    const cs = makeChangeSet([]);
    const live = liveWithAdmins(["alice", "bob"]);
    const result = runGuardrails(cs, live);
    expect(result.ok).toBe(true);
  });

  it("resolves renames before running guardrails", () => {
    // Rename old-alice → alice. Without resolution, this looks like 1 delete
    // out of 1 entry = 100%, which would trip the cap.
    const cs = makeChangeSet([
      {
        kind: "delete",
        resourceType: "member",
        key: "old-alice",
        before: { login: "old-alice", role: "admin" },
      },
      {
        kind: "create",
        resourceType: "member",
        key: "alice",
        after: { login: "alice", role: "admin", previously: "old-alice" },
      },
    ]);
    const live = liveWithAdmins(["old-alice", "bob"]);
    // maxFraction 0.01 would trip if the rename were counted as a delete
    const result = runGuardrails(cs, live, {
      removalDeltaCap: { maxFraction: 0.01 },
    });
    expect(result.ok).toBe(true);
  });
});
