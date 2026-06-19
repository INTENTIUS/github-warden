/**
 * Provider-agnostic reconcile core.
 *
 * Now sourced from the shared `@intentius/chant/reconcile` primitive (chant#501)
 * rather than vendored here — the change-set model, generic collection diff
 * (selective-by-omission + ownership-gated deletes), plan renderer, and
 * guardrail framework all live in chant so every git-host warden consumes one
 * copy (github-warden#20).
 *
 * This module re-exports that primitive so the existing in-repo import surface
 * (`./core.js`, used by diff.ts / guardrails.ts / index.ts) is unchanged. The
 * GitHub-specific resource diffing, live-state types, and member-aware
 * guardrails continue to build on it in `diff.ts` / `guardrails.ts`.
 */

export * from "@intentius/chant/reconcile";
