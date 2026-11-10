#!/usr/bin/env bash
# Build the two job images from THIS checkout and publish them, so a deployment pulls exactly what this source is.
#
# WHY THE JOB IMAGES STILL BYPASS CI. The control-plane images (the compose worker/console and the
# receiver) are built and pushed by .github/workflows/images.yml on every push to main; the job images are
# not, for two reasons a shared runner cannot satisfy: a released version tag here never moves (the
# guard below is what refuses to re-push one), and the Java image bakes ONE deployment network's Maven
# mirror/proxy settings into the image, read from the environment at build time below. What the script
# removes is the remembering: the version comes from the root `package.json` (the same
# number `deploy/docker-compose.yml` pins, held together by a test), the base/local tag pair comes out one build,
# and the Java image is built from the tag that build just made instead of from whatever `latest` happens to be.
#
#   ./image/publish.sh                  # build both, push :<version> and :latest
#   ./image/publish.sh --no-push        # build only (for a host that will run them here)
#   ./image/publish.sh --republish      # push a <version> tag that is already on the registry (see below)
#
# The Maven settings of a Java job are a fact about the NETWORK it runs in, so they are read from the environment
# and baked into the Java image here, not left to the job:
#
#   MAVEN_MIRROR_URL=https://maven.example.com/repository/public \
#   MAVEN_PROXY_HOST=172.17.0.1 MAVEN_PROXY_PORT=3128 \
#   MAVEN_PROXY_NONPROXY='localhost|127.0.0.1' ./image/publish.sh
#
# Empty (the default) means Maven Central directly, which is what a build machine with open egress needs. The proxy
# host must be the address a JOB CONTAINER can reach (the egress proxy's name or address on the job's network, not
# the host's loopback), and it is baked into the image: a change of network means a new image, which is what
# `run.image` is for.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO=${PI_IMAGE_REPOSITORY:-docker.io/ddv12138/pi-job}
JAVA_REPO=${PI_JAVA_IMAGE_REPOSITORY:-${REPO}-java21}
# The worker's own default names this repository too (worker/src/up.mjs UPSTREAM_IMAGE); the tag below is the one
# deploy/docker-compose.yml pins, and a test holds all three to the root package.json version.
VERSION=$(node -p "require('$ROOT/package.json').version")

PUSH=1
REPUBLISH=0
for arg in "$@"; do
	case "$arg" in
		--no-push) PUSH=0 ;;
		--republish) REPUBLISH=1 ;;
		*) echo "usage: $0 [--no-push] [--republish]" >&2; exit 2 ;;
	esac
done

# A RELEASED VERSION TAG NEVER MOVES, and this script is the only thing that could move one. Its tags are what a
# deployment pins (`deploy/docker-compose.yml`) and what a README tells an operator to pull, so re-pushing over them
# would silently change the image under every deployment that pinned that number while the number still claims to be
# one released thing. Bumping the root version is the answer; `--republish` is the deliberate override for an image
# that was published broken and never ran anywhere.
#
# Fails CLOSED when it cannot tell: only an explicit "not found" answers; a network fault, an expired login or a 5xx
# refuses rather than guessing, because guessing here means overwriting a released tag.
NEEDS_PUSH=0
[ "$PUSH" -eq 1 ] && NEEDS_PUSH=1
if [ "$NEEDS_PUSH" -eq 1 ] && [ "$REPUBLISH" -eq 0 ]; then
	for name in "$REPO:$VERSION" "$JAVA_REPO:$VERSION"; do
		out=$(docker buildx imagetools inspect "$name" 2>&1) && {
			echo "refusing: $name is already on the registry, and a released version tag never moves." >&2
			echo "  bump the root package.json version and run again, or pass --republish if this tag never ran anywhere." >&2
			exit 1
		}
		case "$out" in
			*": not found"*|*MANIFEST_UNKNOWN*|*"manifest unknown"*) ;;
			*)
				echo "refusing: could not tell whether $name exists (docker buildx imagetools inspect said):" >&2
				printf '%s\n' "$out" >&2
				exit 1
				;;
		esac
	done
fi

cd "$ROOT"

echo "== default job image: $REPO:$VERSION (also tagged latest, and pi-job:$VERSION locally)"
# One build, two names: `pi-job:$VERSION` is what image/Dockerfile.java21's BASE defaults to, so the Java image
# built next inherits the bytes just built rather than a registry round trip or a stale local tag.
docker build \
	-f image/Dockerfile \
	-t "pi-job:$VERSION" \
	-t "$REPO:$VERSION" \
	-t "$REPO:latest" \
	.

echo "== Java toolchain image: $JAVA_REPO:$VERSION (also tagged latest)"
docker build \
	-f image/Dockerfile.java21 \
	--build-arg "BASE=pi-job:$VERSION" \
	--build-arg "MAVEN_MIRROR_URL=${MAVEN_MIRROR_URL:-}" \
	--build-arg "MAVEN_PROXY_HOST=${MAVEN_PROXY_HOST:-}" \
	--build-arg "MAVEN_PROXY_PORT=${MAVEN_PROXY_PORT:-3128}" \
	--build-arg "MAVEN_PROXY_NONPROXY=${MAVEN_PROXY_NONPROXY:-}" \
	-t "$JAVA_REPO:$VERSION" \
	-t "$JAVA_REPO:latest" \
	.

if [ "$PUSH" -eq 1 ]; then
	# `latest` as well as the version, deliberately: a deployment that does not name PI_JOB_IMAGE falls back to
	# `pi-job:latest`, and `up` fetches it from UPSTREAM_IMAGE. A version tag alone would leave that path with nothing
	# to pull, which reads as "the registry does not have the image" rather than "only the pinned tag was pushed".
	for name in "$REPO:$VERSION" "$REPO:latest" "$JAVA_REPO:$VERSION" "$JAVA_REPO:latest"; do
		echo "== push $name"
		docker push "$name"
	done
fi

echo
echo "next: on the deployment host, pull and point the trigger at it"
echo "  docker pull $REPO:$VERSION"
echo "  docker pull $JAVA_REPO:$VERSION"
echo "  {\"run\": {\"image\": \"$JAVA_REPO:$VERSION\"}}   # a Java trigger's run.image; omitted = the deployment default"
