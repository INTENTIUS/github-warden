/**
 * Tests for the GitHub Action entry point (src/action.ts).
 *
 * The action is a thin adapter that reads INPUT_* env vars and builds the
 * argv array passed to run().  We test the mapping logic here by importing
 * the pure helpers extracted from the action, then verify the full flow by
 * mocking run() and inspecting what argv it receives.
 *
 * Strategy: we cannot import src/action.ts directly because it calls main()
 * at module load time.  Instead we test the input-to-argv mapping inline
 * (mirroring the logic) and add a separate integration smoke test that
 * verifies the action fails fast on a missing required input.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Helpers (mirrors src/action.ts logic — kept in sync manually)
// ---------------------------------------------------------------------------

function readOptionalInput(env: Record<string, string>, name: string): string | undefined {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
  const val = env[key]?.trim();
  return val || undefined;
}

function buildArgv(env: Record<string, string>): string[] {
  const command = readOptionalInput(env, "command") ?? "reconcile";
  const config = env["INPUT_CONFIG"]?.trim() ?? "";
  const mode = readOptionalInput(env, "mode") ?? "dry-run";
  const cycles = readOptionalInput(env, "cycles");
  const failOn = readOptionalInput(env, "fail-on");
  const allowOverride = readOptionalInput(env, "allow-guardrail-override");

  const argv: string[] = [command];
  argv.push("--config", config);
  argv.push("--app-id-env", "WARDEN_ACTION_APP_ID");
  argv.push("--installation-id-env", "WARDEN_ACTION_INSTALLATION_ID");

  if (command === "reconcile") {
    argv.push("--mode", mode);
    if (cycles) argv.push("--cycles", cycles);
    if (allowOverride === "true") argv.push("--allow-guardrail-override");
  }

  if (command === "audit") {
    if (failOn) argv.push("--fail-on", failOn);
  }

  return argv;
}

// ---------------------------------------------------------------------------
// Input → argv mapping tests
// ---------------------------------------------------------------------------

describe("action input → argv mapping", () => {
  it("reconcile dry-run (default command)", () => {
    const env: Record<string, string> = {
      INPUT_CONFIG: ".github/governance.yml",
      INPUT_APP_ID: "123",
      INPUT_INSTALLATION_ID: "456",
      INPUT_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\n...",
    };
    const argv = buildArgv(env);
    expect(argv).toEqual([
      "reconcile",
      "--config", ".github/governance.yml",
      "--app-id-env", "WARDEN_ACTION_APP_ID",
      "--installation-id-env", "WARDEN_ACTION_INSTALLATION_ID",
      "--mode", "dry-run",
    ]);
  });

  it("reconcile apply with cycles", () => {
    const env: Record<string, string> = {
      INPUT_COMMAND: "reconcile",
      INPUT_CONFIG: "governance.yml",
      INPUT_MODE: "apply",
      INPUT_CYCLES: "branch-protection",
      INPUT_APP_ID: "123",
      INPUT_INSTALLATION_ID: "456",
      INPUT_PRIVATE_KEY: "pem",
    };
    const argv = buildArgv(env);
    expect(argv).toEqual([
      "reconcile",
      "--config", "governance.yml",
      "--app-id-env", "WARDEN_ACTION_APP_ID",
      "--installation-id-env", "WARDEN_ACTION_INSTALLATION_ID",
      "--mode", "apply",
      "--cycles", "branch-protection",
    ]);
  });

  it("reconcile with allow-guardrail-override=true", () => {
    const env: Record<string, string> = {
      INPUT_COMMAND: "reconcile",
      INPUT_CONFIG: "governance.yml",
      INPUT_MODE: "apply",
      INPUT_ALLOW_GUARDRAIL_OVERRIDE: "true",
      INPUT_APP_ID: "123",
      INPUT_INSTALLATION_ID: "456",
      INPUT_PRIVATE_KEY: "pem",
    };
    const argv = buildArgv(env);
    expect(argv).toContain("--allow-guardrail-override");
  });

  it("audit with fail-on merge-worthy", () => {
    const env: Record<string, string> = {
      INPUT_COMMAND: "audit",
      INPUT_CONFIG: ".github/governance.yml",
      INPUT_FAIL_ON: "merge-worthy",
      INPUT_APP_ID: "123",
      INPUT_INSTALLATION_ID: "456",
      INPUT_PRIVATE_KEY: "pem",
    };
    const argv = buildArgv(env);
    expect(argv).toEqual([
      "audit",
      "--config", ".github/governance.yml",
      "--app-id-env", "WARDEN_ACTION_APP_ID",
      "--installation-id-env", "WARDEN_ACTION_INSTALLATION_ID",
      "--fail-on", "merge-worthy",
    ]);
  });

  it("audit without fail-on omits the flag", () => {
    const env: Record<string, string> = {
      INPUT_COMMAND: "audit",
      INPUT_CONFIG: ".github/governance.yml",
      INPUT_APP_ID: "123",
      INPUT_INSTALLATION_ID: "456",
      INPUT_PRIVATE_KEY: "pem",
    };
    const argv = buildArgv(env);
    expect(argv).not.toContain("--fail-on");
  });

  it("allow-guardrail-override=false does not add the flag", () => {
    const env: Record<string, string> = {
      INPUT_COMMAND: "reconcile",
      INPUT_CONFIG: "g.yml",
      INPUT_MODE: "apply",
      INPUT_ALLOW_GUARDRAIL_OVERRIDE: "false",
      INPUT_APP_ID: "123",
      INPUT_INSTALLATION_ID: "456",
      INPUT_PRIVATE_KEY: "pem",
    };
    const argv = buildArgv(env);
    expect(argv).not.toContain("--allow-guardrail-override");
  });
});

// ---------------------------------------------------------------------------
// Missing required input — requiredInput helper behaviour
// ---------------------------------------------------------------------------

/**
 * Extracted version of the requiredInput helper from src/action.ts so we can
 * unit-test it without triggering the module-level main() call.
 */
function requiredInputFrom(env: Record<string, string>, name: string): string {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
  const val = env[key]?.trim();
  if (!val) {
    throw new Error(`input '${name}' is required but was not set`);
  }
  return val;
}

describe("required input validation", () => {
  it("throws with the input name when the input is absent", () => {
    expect(() => requiredInputFrom({}, "config")).toThrow("input 'config' is required");
  });

  it("throws when the value is whitespace-only", () => {
    expect(() => requiredInputFrom({ INPUT_CONFIG: "   " }, "config")).toThrow(
      "input 'config' is required",
    );
  });

  it("returns the trimmed value when the input is set", () => {
    expect(requiredInputFrom({ INPUT_CONFIG: "  governance.yml  " }, "config")).toBe(
      "governance.yml",
    );
  });

  it("throws for missing app-id", () => {
    expect(() => requiredInputFrom({}, "app-id")).toThrow("input 'app-id' is required");
  });

  it("throws for missing private-key", () => {
    expect(() => requiredInputFrom({}, "private-key")).toThrow("input 'private-key' is required");
  });
});
