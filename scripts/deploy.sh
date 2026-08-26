#!/bin/sh
# Start 말새김 with docker compose, prompting for secrets that are not set anywhere.
#
#   sh scripts/deploy.sh [docker options] [compose up arguments]
#   sh scripts/deploy.sh -d --build
#   sh scripts/deploy.sh --context prod -d --build
#
# Docker global options accepted in front: --context/-c NAME, --host/-H URL, --config DIR
# (also as --context=NAME etc.). They are handed to the Docker CLI through its native
# environment variables (DOCKER_CONTEXT, DOCKER_HOST, DOCKER_CONFIG), which you may set
# directly instead. Everything after them is passed to `docker compose up`.
#
# The ASR API key is not a server setting (BYOK) — nothing is prompted for it.
# Prompted values live only in this process's environment; nothing is written to disk.
# APP_SHARED_PASSWORD is optional (login disabled when unset); AUTH_COOKIE_SECRET is optional too.
# When launched in its own terminal window (Finder / login) it drops into a shell afterwards
# instead of letting the window close with "[Process completed]".
set -eu

cd "$(dirname "$0")/.."

# Peel Docker global options off the front of the argument list
while [ $# -gt 0 ]; do
  case "$1" in
    --context|-c) DOCKER_CONTEXT=$2; export DOCKER_CONTEXT; shift 2 ;;
    --context=*) DOCKER_CONTEXT=${1#--context=}; export DOCKER_CONTEXT; shift ;;
    --host|-H) DOCKER_HOST=$2; export DOCKER_HOST; shift 2 ;;
    --host=*) DOCKER_HOST=${1#--host=}; export DOCKER_HOST; shift ;;
    --config) DOCKER_CONFIG=$2; export DOCKER_CONFIG; shift 2 ;;
    --config=*) DOCKER_CONFIG=${1#--config=}; export DOCKER_CONFIG; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ -z "${DOCKER_CONTEXT:-}" ] || echo "docker context: $DOCKER_CONTEXT" >&2
[ -z "${DOCKER_HOST:-}" ] || echo "docker host: $DOCKER_HOST" >&2

# Load .env so values defined there count as "set" (same file Compose uses for substitution)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

prompt_secret() {
  # $1 = variable name, $2 = label
  if [ ! -t 0 ]; then
    echo "error: $1 is not set and stdin is not a terminal — export $1 or put it in .env" >&2
    exit 1
  fi
  printf '%s (input hidden): ' "$2"
  stty -echo
  read -r value
  stty echo
  echo
  if [ -z "$value" ]; then
    echo "note: $1 left empty — users must enter their own key on the 설정 (BYOK) page" >&2
  fi
  eval "$1=\$value"
  export "$1"
}


# The shared password is optional: without it the app opens without a login page
if [ -z "${APP_SHARED_PASSWORD:-}" ]; then
  echo "note: APP_SHARED_PASSWORD is not set — login is disabled, the app opens directly" >&2
elif [ -z "${AUTH_COOKIE_SECRET:-}" ]; then
  echo "note: AUTH_COOKIE_SECRET is not set — session cookies are signed with a key derived from the password" >&2
fi

# Was this script started from an interactive shell (sh scripts/deploy.sh ...) or on its own,
# e.g. opened from Finder? In the latter case the window would close with "[Process completed]"
# as soon as docker returns, so we keep it alive with a login shell.
parent_is_shell() {
  case "$(ps -o comm= -p "$PPID" 2>/dev/null)" in
    *sh|*fish|*nu) return 0 ;;
    *) return 1 ;;
  esac
}

status=0
docker compose up "$@" || status=$?

if [ -t 0 ] && ! parent_is_shell; then
  echo >&2
  echo "docker compose exited with status $status — starting a shell so this window stays open (type exit to close)" >&2
  cd "$HOME" 2>/dev/null || true
  exec "${SHELL:-/bin/sh}" -l
fi
exit $status