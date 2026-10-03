#!/usr/bin/env bash
# Build the image for linux/amd64 + linux/arm64 and push it to GHCR, using the same naming and tags as CI:
#   <image>:latest  and  <image>:sha-<full git commit sha>
#
# Usage:
#   echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin   # token needs write:packages
#   npm run docker:publish
#
# Environment:
#   APP_IMAGE_NAME  image name, e.g. ghcr.io/<owner>/<repo> (default: derived from the git remote "origin")
#   PLATFORMS       default linux/amd64,linux/arm64
#   SKIP_SMOKE=1    skip the local Docker smoke test before pushing
#   ALLOW_DIRTY=1   allow publishing with uncommitted changes (the sha tag would not match the content)
#   DRY_RUN=1       print what would be built and pushed, without building or pushing
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-searchads-mcp-multiarch}"

run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

die() {
  echo "error: $*" >&2
  exit 1
}

# ---------------------------------------------------------------- image name
IMAGE="${APP_IMAGE_NAME:-}"
REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
if [[ -z "$IMAGE" ]]; then
  # git@github.com:Owner/Repo.git | https://github.com/Owner/Repo(.git)
  if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/]+)$ ]]; then
    IMAGE="ghcr.io/${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
  else
    die "set APP_IMAGE_NAME (e.g. ghcr.io/<owner>/<repo>); no GitHub 'origin' remote to derive it from"
  fi
fi
IMAGE="$(printf '%s' "$IMAGE" | tr '[:upper:]' '[:lower:]')"
[[ "$IMAGE" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ ]] || die "invalid image name: $IMAGE"

# ---------------------------------------------------------------- tags (same as CI)
SHA="$(git rev-parse HEAD 2>/dev/null || true)"
[[ -n "$SHA" ]] || die "not a git checkout: the sha-<commit> tag needs a commit"
if [[ -n "$(git status --porcelain 2>/dev/null)" && "${ALLOW_DIRTY:-0}" != "1" ]]; then
  die "uncommitted changes; commit first or set ALLOW_DIRTY=1"
fi
TAGS=("${IMAGE}:latest" "${IMAGE}:sha-${SHA}")

SOURCE_URL=""
if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/]+)$ ]]; then
  SOURCE_URL="https://github.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
fi

echo "==> Image:     $IMAGE"
echo "==> Tags:      ${TAGS[*]}"
echo "==> Platforms: $PLATFORMS"

# ---------------------------------------------------------------- smoke test first
if [[ "${SKIP_SMOKE:-0}" != "1" ]]; then
  echo "==> Running the Docker smoke test on a local build"
  run bash scripts/docker-smoke-test.sh
fi

# ---------------------------------------------------------------- multi-arch builder
if [[ "${DRY_RUN:-0}" != "1" ]] && ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "==> Creating buildx builder $BUILDER (docker-container driver, needed for multi-platform pushes)"
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

# ---------------------------------------------------------------- build + push
args=(
  docker buildx build
  --builder "$BUILDER"
  --platform "$PLATFORMS"
  --target runtime
  --provenance=true
  --sbom=true
  --label "org.opencontainers.image.title=Apple Search Ads MCP"
  --label "org.opencontainers.image.revision=${SHA}"
  --label "org.opencontainers.image.licenses=MIT"
)
[[ -n "$SOURCE_URL" ]] && args+=(--label "org.opencontainers.image.source=${SOURCE_URL}")
for tag in "${TAGS[@]}"; do args+=(--tag "$tag"); done
args+=(--push .)

echo "==> Building and pushing"
if ! run "${args[@]}"; then
  echo >&2
  echo "Push failed. If this is an authentication error, log in first:" >&2
  echo "  echo \"\$GHCR_TOKEN\" | docker login ghcr.io -u <github-user> --password-stdin" >&2
  echo "  (or: gh auth refresh -s write:packages && gh auth token | docker login ghcr.io -u <github-user> --password-stdin)" >&2
  exit 1
fi

echo "==> Published:"
for tag in "${TAGS[@]}"; do echo "    $tag"; done
