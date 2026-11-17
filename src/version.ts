/**
 * The version this build reports.
 *
 * The npm package carries the version chant release stamps into package.json
 * before it builds, so there package.json is right. The committed action
 * bundle (action/index.mjs) is built before any release commit exists, so its
 * inlined package.json version is the previous release. When running as the
 * action, the ref the workflow used (`uses: INTENTIUS/github-warden@v0.8.1`)
 * names the release, so that wins when it is a version tag. Anything else (a
 * branch, a commit SHA, a floating major tag) falls back to package.json.
 */
import pkg from "../package.json" with { type: "json" };

const VERSION_TAG = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** The version a ref names, or undefined when the ref is not a version tag. */
export function versionFromRef(ref: string | undefined): string | undefined {
  return ref ? VERSION_TAG.exec(ref.trim())?.[1] : undefined;
}

/**
 * The version to report: the action's ref when it is a version tag, else package.json's.
 * GITHUB_WARDEN_IS_ACTION is replaced at action build time (build:action), so it must be
 * read as a literal `process.env` access and not through a passed-in env.
 */
export function wardenVersion(
  ref: string | undefined = process.env["GITHUB_ACTION_REF"],
  isAction: boolean = !!process.env["GITHUB_WARDEN_IS_ACTION"],
): string {
  return (isAction ? versionFromRef(ref) : undefined) ?? pkg.version;
}
