import { defineConfig } from "vitest/config";

// Separate config for the gated end-to-end suite (real GitHub org). Kept out of
// the default `npm test` run, which only globs `src/**`. Run with
// `npm run test:e2e`; the suite self-skips unless the WARDEN_E2E_* env vars are
// set. A generous timeout absorbs real network latency / pagination.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
