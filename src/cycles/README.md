# Cycles — copy-template guide

A **cycle** is one reconcile domain. It declares how to read live state from
GitHub, how to derive desired state from config, and how to apply one
`ChangeSetEntry` back. The runner (`reconcile/runner.ts`) supplies diff,
guardrails, dry-run, and apply orchestration around every cycle.

`branch-protection.ts` is the template. Every subsequent cycle follows the same
four-part structure.

---

## The four parts

### 1. Config shape

Desired state lives in `src/config/types.ts`. Add fields to the appropriate
interface (`RepoConfig`, `OrgConfig`, etc.). Keep every field optional —
absent means "not managed" (selective-by-omission).

`BranchProtectionConfig` is the example for this cycle.

### 2. `fetchLive`

Signature:

```ts
fetchLive(client: AppClient, orgLogin: string, scope: TScope, budget: RateBudget): Promise<LiveOrgState>
```

- Call `budget.use(n)` before (or immediately after) each GitHub API call.
- Check `budget.exhausted` before paginating or iterating further.
- Return a partial `LiveOrgState` with only the fields this cycle manages.
  Absent fields are not diffed by the runner.
- On 404 (resource does not exist yet) return an empty sub-state rather than
  throwing — the diff will emit a create entry.

### 3. `buildDesired`

Signature:

```ts
buildDesired(config: OrgConfig, orgLogin: string, scope: TScope): OrgConfig
```

- Pure — no I/O.
- Return a minimal `OrgConfig` containing only the fields this cycle manages.
  Strip everything else so the diff focuses on one domain.
- If the returned config has no managed fields for a repo/resource, the diff
  emits zero entries for it (selective-by-omission).

### 4. `apply`

Signature:

```ts
apply(client: AppClient, entry: ChangeSetEntry, orgLogin: string, scope: TScope, budget: RateBudget): Promise<void>
```

- Dispatch on `entry.kind`: `"create"` | `"update"` | `"delete"`.
- Call `budget.use(1)` before each network call.
- Ignore entries whose `resourceType` does not belong to this cycle.
- The `key` convention follows `diff.ts`:
  - top-level: `"<resource-name>"`
  - nested: `"<parent>/<child>"` (e.g. `"my-repo/main"`)

---

## Registering a cycle

Export the cycle instance from this file, then re-export from
`src/index.ts`:

```ts
export { branchProtectionCycle } from "./cycles/branch-protection.js";
```

Pass it to `runReconcile`:

```ts
import { branchProtectionCycle } from "@intentius/chant-lexicon-github-org";

await runReconcile({
  config,
  client,
  // The scope is a typed object, not a bare string. For branch-protection it is
  // `BranchProtectionScope` ({ repos? }). The org login is supplied per-org by
  // the runner as `orgLogin`, not via scope.
  cycles: [branchProtectionCycle],
  scope: { repos: config.orgs["my-org"]?.repos },
  mode: "dry-run",
});
```

---

## Checklist for new cycles

- [ ] Config fields added to `src/config/types.ts` (all optional)
- [ ] `LiveXxx` types added or reused from `src/reconcile/diff.ts`
- [ ] `fetchLive` charges the budget for every API call
- [ ] `buildDesired` is pure and returns a minimal `OrgConfig`
- [ ] `apply` handles create / update / delete and ignores foreign resource types
- [ ] Cycle exported from `src/index.ts`
- [ ] Unit tests: buildDesired, fetchLive mapping, diff, apply create/update/delete
- [ ] Runner integration test: dry-run plan, guardrail trip (if applicable)

---

## Known limitation: wildcard branch-protection patterns

The classic branch-protection cycle (`branch-protection.ts`) fetches live state
by probing each branch name via
`GET /repos/{owner}/{repo}/branches/{branch}/protection`. This API accepts only
**literal** branch names — it cannot enumerate or match wildcard patterns.

A protection rule with a wildcard pattern like `release/*` exists on GitHub's
side but is never returned by a literal-branch probe. As a result:

- `dump` silently omits wildcard-pattern rules (see `src/reconcile/dump.ts`).
- A subsequent reconcile diff will propose **deleting** any undiscovered wildcard
  rule, since it is absent from the desired config.

**Workaround**: after running `dump`, manually inspect the repo's branch
protection settings in GitHub and add wildcard-pattern rules to the emitted
config before committing.

**Proper fix**: GitHub's repository-ruleset API
(`GET /repos/{owner}/{repo}/rulesets`) supports wildcard and regex patterns and
is the modern replacement for classic branch protection. A rulesets cycle is
tracked in issue #462. Until it ships, wildcard patterns are not covered.
