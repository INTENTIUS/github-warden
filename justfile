# github-warden task runner.
# Run `just` (or `just --list`) to see available recipes.

set quiet

# List recipes
default:
    @just --list

# Type-check (no emit)
tsc:
    npx tsc --noEmit

# Run the test suite (optionally pass a path/pattern: `just test diff`)
test *args:
    npx vitest run {{args}}

# Run tests in watch mode
test-watch:
    npx vitest

# Build the CLI bundle (dist/cli.js)
build:
    npm run build

# Build the GitHub Action bundle (action/index.mjs)
build-action:
    npm run build:action

# Everything CI's `check` job runs: typecheck, tests, action bundle freshness
check: tsc test build-action
    git diff --exit-code action/index.mjs

# Dogfood: audit our own config with chant (CI's `dogfood-audit` job)
audit:
    npx chant audit . --fail-on merge-worthy

# Install dependencies (clean, lockfile-faithful)
install:
    npm ci

# Bump version, tag, and push to trigger the npm publish workflow (e.g. just release patch)
release bump="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    current=$(node -e "process.stdout.write(require('./package.json').version)")
    IFS='.' read -r major minor patch <<< "$current"
    case "{{bump}}" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) echo "Usage: just release [major|minor|patch]"; exit 1 ;;
    esac
    next="$major.$minor.$patch"
    echo "Bumping $current → $next"
    npm version "$next" --no-git-tag-version
    git add package.json package-lock.json
    git commit -m "v$next"
    git tag "v$next"
    git push origin main "v$next"
    echo "Released v$next — publish workflow triggered (tag pattern v*)"

# Wire the e2e repo secrets from an already-installed GitHub App (the
# gh-automatable part of e2e setup). Discovers the App id + installation id
# from the org and sets all four WARDEN_E2E_* secrets.
#   just e2e-setup <test-org> <app-slug> <path-to-private-key.pem>
# Prereqs you must do by hand first (not available via gh/API): create the
# GitHub App, download its .pem, and install it on the test org.
e2e-setup org app_slug pem:
    #!/usr/bin/env bash
    set -euo pipefail
    repo="intentius/github-warden"
    if [ ! -f "{{pem}}" ]; then echo "private key not found: {{pem}}" >&2; exit 1; fi
    echo "Looking up '{{app_slug}}' installation on org '{{org}}'…"
    inst=$(gh api "/orgs/{{org}}/installations" --jq '.installations[] | select(.app_slug=="{{app_slug}}")')
    if [ -z "$inst" ]; then echo "No '{{app_slug}}' installation found on '{{org}}' (is it installed?)" >&2; exit 1; fi
    app_id=$(echo "$inst" | jq -r .app_id)
    install_id=$(echo "$inst" | jq -r .id)
    echo "Found app_id=$app_id installation_id=$install_id"
    gh secret set WARDEN_E2E_ORG             --repo "$repo" --body "{{org}}"
    gh secret set WARDEN_E2E_APP_ID          --repo "$repo" --body "$app_id"
    gh secret set WARDEN_E2E_INSTALLATION_ID --repo "$repo" --body "$install_id"
    gh secret set WARDEN_E2E_PRIVATE_KEY     --repo "$repo" < "{{pem}}"
    echo "Set 4 e2e secrets on $repo. Kick it off with: just e2e-run"

# Trigger the e2e workflow on GitHub (set apply=true to also run Phase 2).
#   just e2e-run            # Phase 1 only
#   just e2e-run true       # + the teardown-guarded apply phase
e2e-run apply="false":
    gh workflow run e2e.yml --repo intentius/github-warden -f apply={{apply}}
    echo "Dispatched e2e.yml — watch with: gh run watch \$(gh run list --repo intentius/github-warden --workflow e2e.yml --limit 1 --json databaseId -q '.[0].databaseId')"
