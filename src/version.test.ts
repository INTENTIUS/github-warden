import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { versionFromRef, wardenVersion } from "./version.js";

describe("versionFromRef", () => {
  it("reads a version tag, with or without the v", () => {
    expect(versionFromRef("v0.8.1")).toBe("0.8.1");
    expect(versionFromRef("0.8.1")).toBe("0.8.1");
    expect(versionFromRef("v1.0.0-rc.1")).toBe("1.0.0-rc.1");
  });

  it("ignores refs that are not a full version", () => {
    for (const ref of [undefined, "", "main", "v0", "v0.8", "feat/x", "7cd5abf0e0b8c4d7a1f3b2c9d8e7f6a5b4c3d2e1"]) {
      expect(versionFromRef(ref)).toBeUndefined();
    }
  });
});

describe("wardenVersion", () => {
  it("uses the action ref when run as the action", () => {
    expect(wardenVersion("v9.9.9", true)).toBe("9.9.9");
  });

  it("falls back to package.json when the ref is not a version tag", () => {
    expect(wardenVersion("main", true)).toBe(pkg.version);
    expect(wardenVersion(undefined, true)).toBe(pkg.version);
  });

  it("ignores the ref outside the action", () => {
    expect(wardenVersion("v9.9.9", false)).toBe(pkg.version);
  });
});
