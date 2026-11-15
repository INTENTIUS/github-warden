// A policy that is code, not data: it reads the environment. Folding refuses
// it with the line; running it accepts whatever the environment said.
export default {
  orgs: {
    "my-org": {
      repos: {
        "my-repo": { hasWiki: process.env.WIKI === "1" },
      },
    },
  },
};
