# Changelog

Notable changes to `@intentius/github-warden`. Versions follow semver, and
releases before `0.4.1` are not recorded here.

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
