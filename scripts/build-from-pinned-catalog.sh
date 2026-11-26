#!/usr/bin/env bash
# Build the workspace from the model catalog revision pinned in nix/model-catalog.json
# instead of generating the catalog from live provider data.
#
# `npm run build` regenerates the catalog on every run, so a commit's type checks and
# tests pass or fail with whatever the providers list that day. This fork tracks a
# release, not the newest upstream commit, so its CI builds the way the Nix package
# does: fetch the pinned revision, verify its hash, hydrate, build offline.
set -euo pipefail

revision=$(node -p "require('./nix/model-catalog.json').revision")
catalog=$(mktemp)
trap 'rm -f "$catalog"' EXIT

curl -fsSL --retry 3 -o "$catalog" \
	"https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier"
echo "${revision#sha256-}  ${catalog}" | sha256sum --check --quiet -

node packages/ai/scripts/hydrate-model-catalog.ts "$catalog"
npm run build:offline
