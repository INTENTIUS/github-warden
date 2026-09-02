# End-to-end suites

Two layers, both under `e2e/` and both self-skipping:

1. The **hermetic compose smoke** (`smoke.e2e.test.ts`) drives every cycle's
   full read/diff/apply loop against a stateful mock GitHub
   (`mock-github/server.mjs`). No credentials, no network, seconds to run.
2. The **real-App e2e** (`warden.e2e.test.ts`) is the non-hermetic layer:
   fetchLive and diff against a real GitHub org via a real App installation.
   This is the only thing that validates the live API contract (especially
   the App-only token endpoints). It is gated on `WARDEN_E2E_*` secrets; see
   the README section "End-to-end tests".

## Running the smoke

```bash
just e2e-up          # docker compose (node:22-alpine serving the mock on :8188)
GITHUB_WARDEN_E2E_URL=http://localhost:8188 npm run test:e2e
just e2e-down
```

No docker? The mock is dependency-free node:

```bash
node e2e/mock-github/server.mjs &
GITHUB_WARDEN_E2E_URL=http://localhost:8188 npm run test:e2e
```

Without `GITHUB_WARDEN_E2E_URL` the smoke skips, and without the
`WARDEN_E2E_*` vars the real-App suite skips, so `npm run test:e2e` is safe
to run anywhere.

## What the mock is

A single in-memory HTTP server (`mock-github/server.mjs`, plain node, no
dependencies) implementing the endpoints the 13 cycles touch. That covers org
and repo settings, membership, and teams with their member and repo
attachments; classic branch protection and rulesets at both scopes (including
GitHub's `exclude: []` conditions echo); security features, environments, and
Actions secrets/variables; the Contents API for `.github/dependabot.yml`;
repo listing and creation, template generate included; and the App-only
fine-grained-PAT endpoints. List endpoints paginate via `per_page`/`page`
with `Link: rel="next"` headers.

Auth mirrors production: the suite generates an RSA key, signs a real App
JWT, and exchanges it at `POST /app/installations/{id}/access_tokens`; every
other endpoint then requires the minted installation token. Test controls
(`/__mock/reset`, `/__mock/forbid` for injected 403s, PAT seeding) bypass
auth.

## Coverage

"yes" means exercised and asserted by the smoke; "n/a" means the behavior
does not exist for that cycle (the reason is noted). Deletes run under
`owned`, with the `removalDeltaCap` arithmetic spelled out in each test.

| Cycle | Read | Apply | Converge | Drift | Delete via `owned` | Gated-read NOTE |
|---|---|---|---|---|---|---|
| org-settings | yes | yes | yes | yes (description) | n/a (singleton) | — |
| repo-settings | yes | yes | yes | yes (has_issues) | n/a (never deletes repos) | — |
| membership | yes | yes | yes | yes (role escalation) | yes (1/4 in cap; 1/3 BLOCKED) | — |
| teams | yes | yes | yes | yes (description) | yes (1/4 in cap) | — |
| branch-protection | yes | yes | yes | yes (re-protect) | n/a (probe reads declared patterns only) | — |
| rulesets | yes | yes | yes (incl. exclude echo) | yes (enforcement) | yes (1/4 in cap) | — |
| security-features | yes | yes | yes | yes (alerts re-enable) | n/a (toggles) | — |
| environments | yes | yes | yes | yes (wait timer) | yes (1/3, cap raised) | — |
| secrets-variables | yes | yes | yes | yes (variable value) | yes (1/6 in cap) | yes (injected org-variables 403 → plan NOTE) |
| dependency-hygiene | yes | yes | yes | yes (file content, sha-aware) | n/a (never deletes the file) | — |
| repo-baseline | yes | yes (empty + template) | yes | n/a (existence-only) | n/a | — |
| token-governance | yes | yes (revoke expired) | yes | n/a (grants are not editable) | n/a (revoke is an update) | — |
| token-approval | yes | yes (approve + deny) | yes | n/a | n/a | — |

Cross-cutting behaviors, also in the smoke:

- Read-only fetchLive is asserted for all 13 cycles before any apply.
- The guardrail block path: shrinking the member policy to drop 1 of 3 live
  members trips `removalDeltaCap` (33% over the 25% cap), blocks the apply,
  and leaves the member in place.
- The permission-gated 403 NOTE path: the mock 403s the org-variables read;
  the cycle plans optimistically and the plan carries the
  `NOTE: org-variables: read was permission-gated (403)` line instead of
  erroring. Per-cycle NOTE behavior is unit-tested in
  `src/cycles/notes.test.ts` and the cycle suites.
- Full-registry convergence: after every per-cycle block, one dry-run of all
  13 cycles over the full policy asserts zero drift everywhere.
- Pagination: a 123-repo org is listed across two pages (Link header plus
  short-page detection), through the same paginator the cycles use.

## The real-App layer

`warden.e2e.test.ts` provisions a throwaway repo plus one variable and one
sealed-box secret in a real org, runs every cycle's fetchLive + diff (Phase
1, read-only asserted), and optionally one apply (Phase 2,
`WARDEN_E2E_APPLY=1`). It is the contract check for the live API: shapes,
auth, and the App-only endpoints. The smoke above is the behavior check for
warden's loop. CI runs the real-App layer nightly via
`.github/workflows/e2e.yml`.
