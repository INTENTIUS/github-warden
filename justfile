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
