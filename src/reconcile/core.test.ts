/**
 * Tests for the provider-agnostic reconcile core.
 *
 * Pure unit tests over the generic primitives — no GitHub types, no I/O.
 */

import { describe, it, expect } from "vitest";
import {
  deepEqual,
  diffFields,
  diffCollection,
  summarizeChangeSet,
  renderChangeSet,
  resolveRenames,
  removalDeltaCap,
  runGuardrailChecks,
} from "./core.js";
import type { ChangeSet, ChangeSetEntry, DiffOptions, GuardrailCheck } from "./core.js";

const noOpts: DiffOptions = {};

// ---------------------------------------------------------------------------
// deepEqual / diffFields
// ---------------------------------------------------------------------------

describe("deepEqual", () => {
  it("compares primitives and nested structures", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

describe("diffFields", () => {
  it("compares every key of desired when no key list is given", () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1, b: 9 })).toEqual([{ field: "b", before: 9, after: 2 }]);
  });

  it("compares only listed keys present in desired", () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 9, b: 9 }, ["a"])).toEqual([{ field: "a", before: 9, after: 1 }]);
  });

  it("ignores listed keys absent from desired (selective-by-omission)", () => {
    expect(diffFields({ a: 1 }, { a: 1, b: 2 }, ["a", "b"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// diffCollection
// ---------------------------------------------------------------------------

interface D { name: string; v?: number }
interface L { name: string; v?: number }

function runCollection(
  desired: D[],
  live: L[],
  opts: DiffOptions = noOpts,
): ChangeSetEntry[] {
  const out: ChangeSetEntry[] = [];
  diffCollection<D, L>({
    resourceType: "thing",
    keyPrefix: "p/",
    desired: new Map(desired.map((d) => [d.name, d])),
    live: new Map(live.map((l) => [l.name, l])),
    compareFields: (d, l) => (d.v !== l.v ? [{ field: "v", before: l.v, after: d.v }] : []),
    opts,
    out,
  });
  return out;
}

describe("diffCollection", () => {
  it("creates entries for desired-not-live (with key prefix)", () => {
    const out = runCollection([{ name: "a", v: 1 }], []);
    expect(out).toEqual([{ kind: "create", resourceType: "thing", key: "p/a", after: { name: "a", v: 1 } }]);
  });

  it("updates when compareFields reports differences", () => {
    const out = runCollection([{ name: "a", v: 2 }], [{ name: "a", v: 1 }]);
    expect(out[0]!.kind).toBe("update");
    expect(out[0]!.fields).toEqual([{ field: "v", before: 1, after: 2 }]);
  });

  it("emits no entry when live matches desired", () => {
    expect(runCollection([{ name: "a", v: 1 }], [{ name: "a", v: 1 }])).toEqual([]);
  });

  it("only deletes live-not-desired when ownership-gated", () => {
    const live = [{ name: "a", v: 1 }, { name: "stray", v: 9 }];
    expect(runCollection([{ name: "a", v: 1 }], live)).toEqual([]); // no predicate
    const owned = runCollection([{ name: "a", v: 1 }], live, { isOwned: (_t, k) => k === "p/stray" });
    expect(owned).toEqual([{ kind: "delete", resourceType: "thing", key: "p/stray", before: { name: "stray", v: 9 } }]);
  });

  it("honours createAfter / updateAfter mappers", () => {
    const out: ChangeSetEntry[] = [];
    diffCollection<D, L>({
      resourceType: "thing",
      desired: new Map([["a", { name: "a", v: 5 }]]),
      live: new Map(),
      compareFields: () => [],
      createAfter: (key, d) => ({ normalized: key, v: d.v }),
      opts: noOpts,
      out,
    });
    expect(out[0]!.after).toEqual({ normalized: "a", v: 5 });
  });
});

// ---------------------------------------------------------------------------
// summarize / render
// ---------------------------------------------------------------------------

describe("summarizeChangeSet / renderChangeSet", () => {
  const cs: ChangeSet = {
    org: "acme",
    entries: [
      { kind: "create", resourceType: "thing", key: "a" },
      { kind: "update", resourceType: "thing", key: "b", fields: [{ field: "v", before: 1, after: 2 }] },
      { kind: "delete", resourceType: "thing", key: "c" },
    ],
  };

  it("counts entries by kind", () => {
    expect(summarizeChangeSet(cs)).toEqual({ create: 1, update: 1, delete: 1 });
  });

  it("renders a readable plan with the scope id and field changes", () => {
    const out = renderChangeSet(cs);
    expect(out).toContain("Plan for acme: 1 to create, 1 to update, 1 to delete");
    expect(out).toContain("[thing] b");
    expect(out).toContain("v: 1 → 2");
  });

  it("renders 'No changes.' for an empty set", () => {
    expect(renderChangeSet({ org: "acme", entries: [] })).toContain("No changes.");
  });
});

// ---------------------------------------------------------------------------
// Guardrail framework
// ---------------------------------------------------------------------------

describe("resolveRenames", () => {
  it("collapses delete(previously)+create(key) into one update", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "delete", resourceType: "team", key: "old", before: { slug: "old" } },
        { kind: "create", resourceType: "team", key: "new", after: { previously: "old" } },
      ],
    };
    const resolved = resolveRenames(cs);
    expect(resolved.entries.some((e) => e.kind === "delete")).toBe(false);
    const update = resolved.entries.find((e) => e.kind === "update")!;
    expect(update.key).toBe("new");
    expect(update.before).toEqual({ slug: "old" });
  });

  it("is a no-op without a matching previously alias", () => {
    const cs: ChangeSet = { org: "acme", entries: [{ kind: "delete", resourceType: "team", key: "old" }] };
    expect(resolveRenames(cs)).toBe(cs);
  });
});

describe("removalDeltaCap", () => {
  it("trips when deletes exceed the fraction of pre-existing entries", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: Array.from({ length: 4 }, (_, i) => ({ kind: "delete" as const, resourceType: "x", key: `k${i}` })),
    };
    expect(removalDeltaCap(cs)!.guardrail).toBe("removalDeltaCap");
  });

  it("excludes creates from the denominator and passes under the cap", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "delete", resourceType: "x", key: "d" },
        { kind: "update", resourceType: "x", key: "u1" },
        { kind: "update", resourceType: "x", key: "u2" },
        { kind: "update", resourceType: "x", key: "u3" },
        { kind: "create", resourceType: "x", key: "c" },
      ],
    };
    expect(removalDeltaCap(cs)).toBeNull(); // 1/4 = 25%, not > 25%
  });
});

describe("runGuardrailChecks", () => {
  it("resolves renames once and aggregates failing checks", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [{ kind: "delete", resourceType: "x", key: "a" }, { kind: "delete", resourceType: "x", key: "b" }],
    };
    const failing: GuardrailCheck = (resolved) => removalDeltaCap(resolved);
    const passing: GuardrailCheck = () => null;
    const result = runGuardrailChecks(cs, [failing, passing]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toHaveLength(1);
  });

  it("returns ok when every check passes", () => {
    const cs: ChangeSet = { org: "acme", entries: [{ kind: "create", resourceType: "x", key: "a" }] };
    expect(runGuardrailChecks(cs, [() => null])).toEqual({ ok: true });
  });
});
