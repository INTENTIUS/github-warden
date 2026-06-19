import { describe, it, expect } from "vitest";
import {
  diff,
  renderChangeSet,
  summarizeChangeSet,
} from "./diff.js";
import type { DiffOptions, LiveOrgState, ChangeSet } from "./diff.js";
import type { OrgConfig } from "../config/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noOwnership(): DiffOptions {
  return {};
}

function ownAll(): DiffOptions {
  return { isOwned: () => true };
}

function ownOnly(owned: string[]): DiffOptions {
  return { isOwned: (_type, key) => owned.includes(key) };
}

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

describe("diff — org settings", () => {
  it("emits create when desired has settings and live has none", () => {
    const desired: OrgConfig = {
      settings: { description: "My org", defaultRepositoryPermission: "read" },
    };
    const live: LiveOrgState = {};
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]).toMatchObject({
      kind: "create",
      resourceType: "org-settings",
      key: "org-settings",
      after: desired.settings,
    });
  });

  it("emits update with field-level diff when settings differ", () => {
    const desired: OrgConfig = {
      settings: { description: "New description", defaultRepositoryPermission: "write" },
    };
    const live: LiveOrgState = {
      settings: { description: "Old description", defaultRepositoryPermission: "read" },
    };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    const entry = cs.entries[0];
    expect(entry.kind).toBe("update");
    expect(entry.fields).toHaveLength(2);
    const fieldNames = entry.fields!.map((f) => f.field);
    expect(fieldNames).toContain("description");
    expect(fieldNames).toContain("defaultRepositoryPermission");
    const descField = entry.fields!.find((f) => f.field === "description")!;
    expect(descField.before).toBe("Old description");
    expect(descField.after).toBe("New description");
  });

  it("emits no change when desired settings match live", () => {
    const desired: OrgConfig = {
      settings: { description: "Same", defaultRepositoryPermission: "read" },
    };
    const live: LiveOrgState = {
      settings: { description: "Same", defaultRepositoryPermission: "read" },
    };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(0);
  });

  it("selective-by-omission: absent settings field is not diffed", () => {
    // desired only manages `description`; `email` is not present even though it
    // differs in live — it must not produce a change.
    const desired: OrgConfig = {
      settings: { description: "My org" },
    };
    const live: LiveOrgState = {
      settings: { description: "My org", email: "contact@example.com" },
    };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(0);
  });

  it("emits no change when settings are absent from desired (not managed)", () => {
    const desired: OrgConfig = {};
    const live: LiveOrgState = { settings: { description: "Something" } };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

describe("diff — teams", () => {
  it("emits create for a team not present in live", () => {
    const desired: OrgConfig = {
      teams: { backend: { description: "Backend team" } },
    };
    const live: LiveOrgState = { teams: {} };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]).toMatchObject({
      kind: "create",
      resourceType: "team",
      key: "backend",
    });
  });

  it("emits update when team description changes", () => {
    const desired: OrgConfig = {
      teams: { backend: { description: "New description" } },
    };
    const live: LiveOrgState = {
      teams: { backend: { description: "Old description" } },
    };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0].kind).toBe("update");
    expect(cs.entries[0].fields).toHaveLength(1);
    expect(cs.entries[0].fields![0].field).toBe("description");
  });

  it("emits delete for a live team not in desired when owned", () => {
    const desired: OrgConfig = { teams: {} };
    const live: LiveOrgState = { teams: { "old-team": { description: "Gone" } } };
    const cs = diff("my-org", desired, live, ownAll());
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]).toMatchObject({ kind: "delete", resourceType: "team", key: "old-team" });
  });

  it("ownership-gated delete: unmanaged live team is NOT deleted", () => {
    const desired: OrgConfig = { teams: {} };
    const live: LiveOrgState = { teams: { "unmanaged-team": { description: "Not ours" } } };
    const cs = diff("my-org", desired, live, noOwnership());
    expect(cs.entries).toHaveLength(0);
  });

  it("emits no changes when teams is absent from desired", () => {
    const desired: OrgConfig = {};
    const live: LiveOrgState = { teams: { backend: { description: "Backend" } } };
    const cs = diff("my-org", desired, live, ownAll());
    expect(cs.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Team members
// ---------------------------------------------------------------------------

describe("diff — team members", () => {
  it("emits create for a new team member", () => {
    const desired: OrgConfig = {
      teams: {
        backend: {
          members: [{ login: "alice", role: "maintainer" }],
        },
      },
    };
    const live: LiveOrgState = {
      teams: { backend: { members: [] } },
    };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]).toMatchObject({
      kind: "create",
      resourceType: "team-member",
      key: "backend/alice",
    });
  });

  it("emits update when member role changes", () => {
    const desired: OrgConfig = {
      teams: {
        backend: { members: [{ login: "alice", role: "maintainer" }] },
      },
    };
    const live: LiveOrgState = {
      teams: { backend: { members: [{ login: "alice", role: "member" }] } },
    };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0].kind).toBe("update");
    expect(cs.entries[0].fields![0]).toMatchObject({
      field: "role",
      before: "member",
      after: "maintainer",
    });
  });

  it("emits delete for removed member when owned", () => {
    const desired: OrgConfig = {
      teams: { backend: { members: [] } },
    };
    const live: LiveOrgState = {
      teams: { backend: { members: [{ login: "bob", role: "member" }] } },
    };
    const cs = diff("my-org", desired, live, ownOnly(["backend/bob"]));
    const deletes = cs.entries.filter((e) => e.kind === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].key).toBe("backend/bob");
  });

  it("ownership-gated: unmanaged member is NOT deleted", () => {
    const desired: OrgConfig = {
      teams: { backend: { members: [{ login: "alice" }] } },
    };
    const live: LiveOrgState = {
      teams: {
        backend: {
          members: [
            { login: "alice", role: "member" },
            { login: "unmanaged-user", role: "member" },
          ],
        },
      },
    };
    const cs = diff("my-org", desired, live, noOwnership());
    const deletes = cs.entries.filter((e) => e.kind === "delete");
    expect(deletes).toHaveLength(0);
  });

  it("selective-by-omission: absent members field means membership is not managed", () => {
    const desired: OrgConfig = {
      teams: { backend: { description: "Backend" } }, // no members key
    };
    const live: LiveOrgState = {
      teams: {
        backend: {
          description: "Backend",
          members: [{ login: "alice", role: "member" }],
        },
      },
    };
    const cs = diff("my-org", desired, live, ownAll());
    // No team changes (description matches), no member creates/deletes
    expect(cs.entries).toHaveLength(0);
  });

  it("defaults missing role to 'member' for comparison", () => {
    const desired: OrgConfig = {
      teams: {
        backend: { members: [{ login: "alice" }] }, // role absent → defaults to member
      },
    };
    const live: LiveOrgState = {
      teams: { backend: { members: [{ login: "alice", role: "member" }] } },
    };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(0); // no diff
  });
});

// ---------------------------------------------------------------------------
// Org members
// ---------------------------------------------------------------------------

describe("diff — org members", () => {
  it("emits create for a new org member", () => {
    const desired: OrgConfig = {
      members: [{ login: "charlie", role: "admin" }],
    };
    const live: LiveOrgState = { members: [] };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]).toMatchObject({
      kind: "create",
      resourceType: "member",
      key: "charlie",
    });
  });

  it("emits delete for removed member when owned", () => {
    const desired: OrgConfig = { members: [] };
    const live: LiveOrgState = { members: [{ login: "dave", role: "member" }] };
    const cs = diff("my-org", desired, live, ownOnly(["dave"]));
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]).toMatchObject({ kind: "delete", key: "dave" });
  });

  it("ownership-gated: unowned live member is NOT deleted", () => {
    const desired: OrgConfig = { members: [{ login: "alice" }] };
    const live: LiveOrgState = {
      members: [
        { login: "alice", role: "member" },
        { login: "external", role: "member" },
      ],
    };
    const cs = diff("my-org", desired, live, noOwnership());
    expect(cs.entries.filter((e) => e.kind === "delete")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

describe("diff — repos", () => {
  it("emits create for a new repo", () => {
    const desired: OrgConfig = {
      repos: { "my-repo": { description: "A repo", private: true } },
    };
    const live: LiveOrgState = { repos: {} };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]).toMatchObject({
      kind: "create",
      resourceType: "repo",
      key: "my-repo",
    });
  });

  it("emits update when repo description changes", () => {
    const desired: OrgConfig = {
      repos: { "my-repo": { description: "New" } },
    };
    const live: LiveOrgState = {
      repos: { "my-repo": { description: "Old" } },
    };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0].kind).toBe("update");
    expect(cs.entries[0].fields![0].field).toBe("description");
  });

  it("emits delete for a live repo when owned", () => {
    const desired: OrgConfig = { repos: {} };
    const live: LiveOrgState = { repos: { "old-repo": { description: "Gone" } } };
    const cs = diff("my-org", desired, live, ownOnly(["old-repo"]));
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]).toMatchObject({ kind: "delete", resourceType: "repo", key: "old-repo" });
  });

  it("ownership-gated: unmanaged live repo is NOT deleted", () => {
    const desired: OrgConfig = { repos: {} };
    const live: LiveOrgState = { repos: { "external-repo": {} } };
    const cs = diff("my-org", desired, live, noOwnership());
    expect(cs.entries).toHaveLength(0);
  });

  it("selective-by-omission: absent repos field means repos are not managed", () => {
    const desired: OrgConfig = {}; // repos key absent
    const live: LiveOrgState = { repos: { "some-repo": { description: "Whatever" } } };
    const cs = diff("my-org", desired, live, ownAll());
    expect(cs.entries).toHaveLength(0);
  });

  it("diffs topics as sorted arrays", () => {
    const desired: OrgConfig = {
      repos: { "my-repo": { topics: ["typescript", "iac"] } },
    };
    const live: LiveOrgState = {
      repos: { "my-repo": { topics: ["iac", "old-topic"] } },
    };
    const cs = diff("my-org", desired, live);
    const topicsField = cs.entries[0]?.fields?.find((f) => f.field === "topics");
    expect(topicsField).toBeDefined();
  });

  it("no-op when repo fields match live", () => {
    const desired: OrgConfig = {
      repos: { "my-repo": { description: "Same", private: false } },
    };
    const live: LiveOrgState = {
      repos: { "my-repo": { description: "Same", private: false } },
    };
    const cs = diff("my-org", desired, live);
    expect(cs.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Branch protection
// ---------------------------------------------------------------------------

describe("diff — branch protection", () => {
  it("emits create for a new branch protection rule", () => {
    const desired: OrgConfig = {
      repos: {
        "my-repo": {
          branchProtection: [
            { pattern: "main", requirePullRequestReviews: true, requiredApprovingReviewCount: 2 },
          ],
        },
      },
    };
    const live: LiveOrgState = { repos: { "my-repo": {} } };
    const cs = diff("my-org", desired, live);
    const creates = cs.entries.filter((e) => e.kind === "create" && e.resourceType === "branch-protection");
    expect(creates).toHaveLength(1);
    expect(creates[0].key).toBe("my-repo/main");
  });

  it("emits update when branch protection rule changes", () => {
    const desired: OrgConfig = {
      repos: {
        "my-repo": {
          branchProtection: [{ pattern: "main", requiredApprovingReviewCount: 2 }],
        },
      },
    };
    const live: LiveOrgState = {
      repos: {
        "my-repo": {
          branchProtection: [{ pattern: "main", requiredApprovingReviewCount: 1 }],
        },
      },
    };
    const cs = diff("my-org", desired, live);
    const updates = cs.entries.filter((e) => e.kind === "update" && e.resourceType === "branch-protection");
    expect(updates).toHaveLength(1);
    expect(updates[0].fields![0].field).toBe("requiredApprovingReviewCount");
  });

  it("selective-by-omission: absent branchProtection means rules are not managed", () => {
    const desired: OrgConfig = {
      repos: { "my-repo": { description: "A repo" } }, // no branchProtection key
    };
    const live: LiveOrgState = {
      repos: {
        "my-repo": {
          description: "A repo",
          branchProtection: [{ pattern: "main", requirePullRequestReviews: true }],
        },
      },
    };
    const cs = diff("my-org", desired, live, ownAll());
    expect(cs.entries).toHaveLength(0);
  });

  it("ownership-gated: unmanaged live branch-protection rule is NOT deleted", () => {
    const desired: OrgConfig = {
      repos: { "my-repo": { branchProtection: [] } },
    };
    const live: LiveOrgState = {
      repos: {
        "my-repo": {
          branchProtection: [{ pattern: "release/*", allowForcePushes: false }],
        },
      },
    };
    const cs = diff("my-org", desired, live, noOwnership());
    expect(cs.entries.filter((e) => e.kind === "delete")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stable ordering
// ---------------------------------------------------------------------------

describe("diff — stable ordering", () => {
  it("entries are sorted by resource type then key", () => {
    const desired: OrgConfig = {
      settings: { description: "Org" },
      teams: {
        zteam: { members: [{ login: "zee" }] },
        ateam: { members: [{ login: "alice" }] },
      },
      members: [{ login: "bob" }],
    };
    const live: LiveOrgState = {};
    const cs = diff("my-org", desired, live);
    const types = cs.entries.map((e) => e.resourceType);
    // org-settings before team before team-member before member
    const settingsIdx = types.indexOf("org-settings");
    const teamIdx = types.indexOf("team");
    const memberIdx = types.findIndex((t) => t === "member");
    expect(settingsIdx).toBeLessThan(teamIdx);
    expect(teamIdx).toBeLessThan(memberIdx);
    // Teams themselves are sorted alphabetically
    const teamEntries = cs.entries.filter((e) => e.resourceType === "team");
    expect(teamEntries[0].key).toBe("ateam");
    expect(teamEntries[1].key).toBe("zteam");
  });

  it("produces identical output for identical inputs (deterministic)", () => {
    const desired: OrgConfig = {
      teams: {
        c: { members: [{ login: "z" }, { login: "a" }] },
        a: {},
      },
    };
    const live: LiveOrgState = {};
    const cs1 = diff("my-org", desired, live);
    const cs2 = diff("my-org", desired, live);
    expect(cs1.entries.map((e) => e.key)).toEqual(cs2.entries.map((e) => e.key));
  });
});

// ---------------------------------------------------------------------------
// Summary + render helpers
// ---------------------------------------------------------------------------

describe("summarizeChangeSet", () => {
  it("counts entries per kind", () => {
    const desired: OrgConfig = {
      settings: { description: "New" },
      teams: { newteam: {} },
      members: [{ login: "alice" }],
    };
    const live: LiveOrgState = {
      settings: { description: "Old" },
    };
    const cs = diff("my-org", desired, live);
    const counts = summarizeChangeSet(cs);
    expect(counts.update).toBeGreaterThanOrEqual(1); // settings update
    expect(counts.create).toBeGreaterThanOrEqual(2); // team + member
    expect(counts.delete).toBe(0);
  });
});

describe("renderChangeSet", () => {
  it("returns a non-empty string with the org name", () => {
    const desired: OrgConfig = {
      settings: { description: "My org" },
    };
    const live: LiveOrgState = {};
    const cs = diff("my-org", desired, live);
    const output = renderChangeSet(cs);
    expect(output).toContain("my-org");
    expect(output).toContain("create");
  });

  it("returns 'No changes' when the change set is empty", () => {
    const cs: ChangeSet = { org: "empty-org", entries: [] };
    expect(renderChangeSet(cs)).toContain("No changes");
  });

  it("includes field-level diff lines in update output", () => {
    const desired: OrgConfig = {
      settings: { description: "New" },
    };
    const live: LiveOrgState = { settings: { description: "Old" } };
    const cs = diff("my-org", desired, live);
    const output = renderChangeSet(cs);
    expect(output).toContain("description");
    expect(output).toContain("Old");
    expect(output).toContain("New");
  });
});
