import { describe, expect, it } from "vitest";
import { NO_POLICY_MESSAGE, POLICY_FILE, resolvePolicyPath } from "./policy-path.js";

const only = (...files: string[]) => (p: string) => files.includes(p);

describe("resolvePolicyPath", () => {
  it("defaults to governance.yml in the working directory", () => {
    expect(POLICY_FILE).toBe("governance.yml");
    expect(resolvePolicyPath(undefined, only("governance.yml"))).toBe("governance.yml");
  });

  it("finds nothing when no path is given and governance.yml is absent", () => {
    expect(resolvePolicyPath(undefined, only())).toBeUndefined();
    expect(NO_POLICY_MESSAGE).toBe("no --config given and no governance.yml in the working directory");
  });

  it("reads a given path as given, even when it is missing", () => {
    expect(resolvePolicyPath("org/policy.json", only())).toBe("org/policy.json");
    expect(resolvePolicyPath(".github/governance.yml", only("governance.yml"))).toBe(".github/governance.yml");
  });
});
