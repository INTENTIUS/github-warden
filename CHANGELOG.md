# Changelog

Notable changes to `@intentius/github-warden`. Versions follow semver, and
releases before `0.4.1` are not recorded here.

## Unreleased

- New `repos` subcommand writes the policy's org's repository list, archived
  repos included, as the `{ forge, org, repos: [{ url, archived? }] }` JSON
  `chant workspace check --forge-repos <file>` reads (#75). `--org` picks the
  org when the policy has several and `--out` names the file (default
  stdout). An org key that is a personal account is listed from the App
  installation's repositories, or from the account's own token. A login
  GitHub does not have exits 3 rather than writing an empty list.
- The policy can be a `.ts` file whose default export is the policy, typed with
  `satisfies GovernanceConfig` (#69). Warden folds it to its value with
  `@intentius/tsad-reference` without running it, so a file that reads the
  environment or otherwise is not data exits 2 with its line and column. The
  new `--config-mode fold|run|check` on `reconcile`, `audit` and `report`, and
  the Action's `config-mode` input, choose folding (the default), importing
  the file, or both with a refusal when they differ. A folded policy's plan
  prints, under each drifted field, where the policy wrote it: `direct`, or the
  preset argument or body line that set it. Without `--config`, warden reads
  `governance.ts` when there is no `governance.yml`. `examples/governance.ts`
  is the example policy in TypeScript.
- The package has a root export, `dist/index.js` with its type declarations,
  so a `.ts` policy can import `GovernanceConfig` from
  `@intentius/github-warden`. It also exports `loadGovernancePolicy`, which
  reads a policy file of any of the three forms. `runReconcile` takes the
  folded policy's `provenance` and returns each cycle's drift `origins`.
  `@intentius/tsad-reference` `^2.3.0` is a runtime dependency; the CLI loads
  it from node_modules and the Action bundles it.
- `reconcile` with no programmatic scope (the CLI and the Action) gives each org's
  cycles that org's declared `repos` and `teams`. Before, the repo-level cycles
  read nothing: the branch-protection and repo-settings cycles threw
  `Cannot read properties of undefined (reading 'repos')`, and the rulesets
  cycle planned a repo create it skipped on apply and still counted as
  `Applied` (#61). A ruleset create or update now counts as applied only when
  GitHub answers with the ruleset. POLICY.md covers repos owned by a personal
  account.
- `reconcile --plan-json <file>` writes the plan as a chant change-set part:
  the object `reconcilePlanPart` from `@intentius/chant/change-set` returns,
  with planner `warden` and lexicon `github`, which chant's
  `readChangeSetPartFile` reads (#74). This changes the file's shape: up to
  0.6.x it was a bare JSON array of chant's reconcile `ChangeSet`, and a
  reader of that array now reads the part (or takes `runReconcile`'s
  `changeSets` as a library). The new `--member <name>` names the member,
  defaulting to the policy file's directory name. A run where a cycle errored
  or was deferred writes the part with `status: "failed"`, no plan digest and
  an `error` naming the missing cycles. `--plan-json` still cannot be combined
  with `--mode apply`. `runReconcile` returns the change sets as `changeSets`.
- New `checks` subcommand reads each member's generated pipeline job names from
  `chant workspace ls --json` and prints the ruleset that requires them as
  status checks. It needs chant 0.101 or newer, which publishes the names.
- New `lifecycle` subcommand reads the `chant/lifecycle` branch name and each member's
  ledger paths from `chant workspace status --json`, and prints the ruleset that
  protects the branch (no deletion, no force push) for the `rulesets` cycle.
- New `codeowners` subcommand generates CODEOWNERS with one rule per member of a
  chant workspace. Members are read through chant's read contract
  (`chant workspace ls --json`), and owners are declared by member name in an
  owners file. See [CLI.md](CLI.md#codeowners).
- The `@intentius/chant` and `@intentius/chant-lexicon-github` range moves from
  `^0.72.1` to `^0.124.95` (#70). On 0.x a caret admits one minor, so each
  bump is explicit. The workspace read contract starts at chant 0.81.
- The governance pipeline the emitter writes pins `actions/checkout` from
  chant's action pin table (`@intentius/chant/action-pins`) instead of its own
  SHA, and every `uses:` line carries its release as a YAML comment. The
  emitted pipeline's own pin moves from v0.3.1 to the v0.6.1 commit (#71).
- Node 24 is the supported runtime: `engines.node` is `>=24`, the Action runs
  on `node24`, and every workflow runs Node 24 with one `actions/checkout` pin.
  CI's check job also runs `npm run build` (#72). CI.md's and the README's
  workflow examples pin `actions/checkout` and the Action to commit SHAs.
- The `forge-governance` kind needs chant 0.124.49 or newer (`memberFile` from
  0.124.48, `graph.reader` from 0.124.49). The test suite validates
  `workspace-kinds.json` against chant's kinds schema and the graph reader's
  output against chant's workspace graph schema (#73).
- `--config` is optional for `reconcile`, `audit` and `report`. Without it the
  policy is `governance.yml` in the working directory, and a run with neither
  exits 2.

## 0.5.0 (2026-09-02)

The removal cap is now evaluated per collection. Deletes of each resource type
are measured against that type's own live managed entries, so live entries of
one type can no longer dilute a wipe of another. Deleting 3 of 4 teams reads
as 75% no matter how many team members or repos are live, and the tripped
diagnostic names the worst offender with its denominator, for example
`3 of 4 live team entries (75%)`.

- `diff()` counts each declared delete-capable collection during its walk and
  stamps the totals on `ChangeSet.managedCounts`; chant's `removalDeltaCap`
  reads them as per-type denominators. Requires `@intentius/chant` and
  `@intentius/chant-lexicon-github` `^0.56.0`, the new dependency floor.
- The new `reconcile` flag `--removal-cap-fraction <value>` sets the cap
  threshold and is validated at parse time, so a value outside (0,1] exits 2.
- Unknown keys in `GuardrailConfig` now throw an error naming the key instead
  of being ignored. A config still carrying the old `removalLiveCap` block
  fails closed rather than silently running without its intended cap.
- The member-aware guardrails (`adminFloor` with `requiredAdmins` and
  `requireSelf`) share one post-apply membership computation, exported as
  `computePostApplyMembers` / `PostApplyMembers`. `requireSelf` now also
  catches a rename that drops the managing identity's login.

### Breaking API changes

The `countLiveManaged` export is removed. Since the diff now computes live
counts natively, read `ChangeSet.managedCounts` off a `diff()` result instead.

`runGuardrails` also lost its fourth `liveManagedTotal` parameter. The
denominators travel on the change set itself, and
`GuardrailConfig.removalDeltaCap` options are forwarded to chant verbatim so
that current and future options keep chant's own precedence.

## 0.4.1 (2026-09-02)

This release contained breaking API changes and should have been a minor
version bump; the breaks are recorded here retroactively.

### What broke, and how to migrate

The `removalLiveCap` function and `RemovalLiveCapOptions` type were removed
from the public API when the warden-local cap was replaced by chant `0.55.0`'s
`removalDeltaCap` and its pooled live denominator (`managedTotal`). To
migrate, import `removalDeltaCap` and `RemovalDeltaCapOptions` instead.

Along with the exports, the `GuardrailConfig.removalLiveCap` key was removed,
and a config still setting it was silently ignored, leaving the run on default
cap settings. To migrate, move the options to
`GuardrailConfig.removalDeltaCap`; as of `0.5.0` the stale key is a hard
error.

Finally, the guardrail id in compliance output and diagnostics changed from
`removalLiveCap` to `removalDeltaCap`. Anything matching on the old id (a log
filter, say, or a check-run parser) needs the new one.

### Everything else in the release

- The reconcile fast path no longer bundles the TypeScript compiler. The audit
  engine is loaded lazily, shrinking the CLI entry chunk from 10.6 MB to
  about 118 KB and cutting cold start from roughly 104 ms to 26 ms.
- Fixed a latent `0.4.0` bug where running `audit` from the bundled CLI
  crashed with `Dynamic require of "fs" is not supported` (esbuild's ESM
  require shim); both bundles now carry a `createRequire` banner.
