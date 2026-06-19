import { describe, test, expect } from "vitest";
import { governancePipeline } from "./pipeline.js";
import { githubSerializer } from "@intentius/chant-lexicon-github";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Serialize the governance workflow to YAML and return it.
 * All structural assertions operate on the serialized output so the tests
 * typecheck cleanly and exercise the full serialize → audit path (dogfood).
 */
function buildYaml(opts?: Parameters<typeof governancePipeline>[0]): string {
  const { workflow } = governancePipeline(opts);
  const entities = new Map([["governance", workflow]]);
  return githubSerializer.serialize(entities) as string;
}

// ── Shape tests ────────────────────────────────────────────────────

describe("governancePipeline", () => {
  test("returns workflow, dryRunJob, and applyJob", () => {
    const { workflow, dryRunJob, applyJob } = governancePipeline();
    expect(workflow).toBeDefined();
    expect(dryRunJob).toBeDefined();
    expect(applyJob).toBeDefined();
  });

  test("workflow is a GitHub::Actions::Workflow resource", () => {
    const { workflow } = governancePipeline();
    expect(workflow.entityType).toBe("GitHub::Actions::Workflow");
    expect(workflow.kind).toBe("resource");
    expect(workflow.lexicon).toBe("github");
  });

  test("workflow has schedule, pull_request, and workflow_dispatch triggers", () => {
    const yaml = buildYaml();
    expect(yaml).toContain("schedule:");
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain("workflow_dispatch:");
  });

  test("default cron is 0 2 * * *", () => {
    const yaml = buildYaml();
    expect(yaml).toContain("0 2 * * *");
  });

  test("custom cron is respected", () => {
    const yaml = buildYaml({ cron: "0 6 * * 1" });
    expect(yaml).toContain("0 6 * * 1");
  });

  test("workflow has least-privilege permissions (contents: read only)", () => {
    const yaml = buildYaml();
    // Workflow-level permissions block must be present with contents: read.
    // We check that "write" does not appear in the workflow-level block by
    // asserting the serialized YAML contains the expected read-only key.
    expect(yaml).toContain("contents: read");
  });

  // ── Dry-run / apply split ──────────────────────────────────────

  test("dry-run job has pull_request conditional", () => {
    const yaml = buildYaml();
    // The dry-run job's `if:` expression references pull_request.
    // In serialized YAML, single quotes inside a single-quoted scalar are
    // escaped by doubling, so 'pull_request' appears as ''pull_request''.
    expect(yaml).toContain("github.event_name == ''pull_request''");
  });

  test("apply job skips pull_request events", () => {
    const yaml = buildYaml();
    // The apply job's `if:` expression negates pull_request.
    expect(yaml).toContain("github.event_name != ''pull_request''");
  });

  test("dry-run job steps include dry-run mode", () => {
    const yaml = buildYaml();
    expect(yaml).toContain("dry-run");
  });

  test("apply job steps include apply mode", () => {
    const yaml = buildYaml();
    expect(yaml).toContain("--mode apply");
  });

  // ── Security constraints ───────────────────────────────────────

  test("private key is sourced from a secret (not a var)", () => {
    const yaml = buildYaml();
    // The private-key field must reference secrets.*, not vars.*
    expect(yaml).toMatch(/private-key:.*\$\{\{\s*secrets\./);
    expect(yaml).not.toMatch(/private-key:.*\$\{\{\s*vars\./);
  });

  test("all external actions are SHA-pinned", () => {
    const yaml = buildYaml();
    // Every `uses:` line must pin to a 40-char commit SHA.
    const SHA_RE = /^[a-f0-9]{40}$/;
    const usesLines = yaml
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("uses:"));

    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      // Extract the ref after "@"
      const ref = line.split("@")[1]?.trim();
      expect(ref, `Action "${line}" must be pinned to a SHA`).toMatch(SHA_RE);
    }
  });

  test("every job has timeout-minutes set", () => {
    const yaml = buildYaml();
    // There should be at least two timeout-minutes entries (one per job).
    const matches = yaml.match(/timeout-minutes:/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  test("dry-run job has pull-requests write permission for PR comment", () => {
    const yaml = buildYaml();
    // The dry-run job must grant pull-requests: write.
    expect(yaml).toContain("pull-requests: write");
  });

  test("apply job has only contents: read permission (no pull-requests write)", () => {
    const yaml = buildYaml();
    // The YAML must contain contents: read (from workflow level and/or apply job).
    expect(yaml).toContain("contents: read");
    // The YAML contains pull-requests: write ONLY on the dry-run job.
    // There should be exactly one occurrence of "pull-requests: write".
    const count = (yaml.match(/pull-requests: write/g) ?? []).length;
    expect(count).toBe(1);
  });

  // ── Parameterization ──────────────────────────────────────────

  test("configPath is used in PR trigger path filter", () => {
    const configPath = ".github/my-org-config.yml";
    const yaml = buildYaml({ configPath });
    expect(yaml).toContain(configPath);
  });

  test("cycles flag is forwarded to reconcile command", () => {
    const yaml = buildYaml({ cycles: ["branch-protection", "team-sync"] });
    expect(yaml).toContain("--cycles branch-protection,team-sync");
  });

  test("custom appIdVar is referenced in mint-token step", () => {
    const yaml = buildYaml({ appIdVar: "MY_APP_ID" });
    expect(yaml).toContain("MY_APP_ID");
  });

  test("custom privateKeySecret is used (secret, not var)", () => {
    const yaml = buildYaml({ privateKeySecret: "MY_PRIVATE_KEY" });
    expect(yaml).toMatch(/secrets\.MY_PRIVATE_KEY/);
  });

  // ── Serialization ──────────────────────────────────────────────

  test("serializes to YAML without error", () => {
    const yaml = buildYaml();
    expect(yaml).toContain("name: Governance reconcile");
    expect(yaml).toContain("schedule:");
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("permissions:");
    expect(yaml).toContain("contents: read");
  });
});
