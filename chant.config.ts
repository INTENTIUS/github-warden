// chant.config.ts: what chant release cuts and publishes. See https://intentius.io/chant/cli/release/
export default {
  release: {
    tag: "v{version}",
    legacyTags: ["v"],
    green: "forge-checks",
    version: { packages: ["."] },
    publish: [{ type: "npm", packages: ["."], stage: false }],
    workflow: { trigger: "dispatch", file: ".github/workflows/publish.yml" },
  },
};
