#!/usr/bin/env bash
#
# Fake gh for the workload-identity.sh test (issue #161). Stateful stand-in for the
# handful of gh calls the script makes:
#
#   gh auth status                    always logged in
#   gh repo view OWNER/REPO           always viewable
#   gh variable set NAME ...          upsert (gh variable set is an upsert in the real CLI)
#   gh api repos/OWNER/REPO/environments/ENV
#                                     GET: 404 when the environment does not exist in the
#                                     state (the script creates it only then); PUT: creates
#                                     it, leaving anything that exists alone — which is
#                                     what keeps GitHub environment protection rules
#                                     untouched ("Re-running" in the README).
#
# State:
#   $FAKE_STATE_DIR/gh/environments/<owner_repo>/<environment>       marker
#   $FAKE_STATE_DIR/gh/variables/<owner_repo>/<environment>/<name>   value
#   $FAKE_STATE_DIR/gh/variables/<owner_repo>/_repository/<name>     value, no --env
#
# Every invocation is appended to calls.log as one line: 'gh' followed by the arguments,
# space-separated (raw, so the test can grep for them).

set -euo pipefail

STATE="${FAKE_STATE_DIR:?fake gh: set FAKE_STATE_DIR}"
mkdir -p "$STATE"
args=("$@")

{
  printf 'gh'
  for a in "${args[@]+"${args[@]}"}"; do printf ' %s' "$a"; done
  printf '\n'
} >>"$STATE/calls.log"

cmdline() { printf '%s' "${args[*]:-}"; }
unhandled() { printf 'ERROR: (fake gh) unhandled invocation: %s\n' "$(cmdline)" >&2; exit 127; }

# gh_flag NAME [DEFAULT] — the value of --NAME VALUE or --NAME=VALUE.
gh_flag() {
  local name="$1" default="${2-}" i
  for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[i]}" in
      --"$name"=*) printf '%s' "${args[i]#--"$name"=}"; return 0 ;;
      --"$name")
        if [[ $((i + 1)) -lt ${#args[@]} ]]; then
          printf '%s' "${args[i + 1]}"
          return 0
        fi
        ;;
    esac
  done
  printf '%s' "$default"
}

repo_slug() { printf '%s' "$1" | tr '/' '_'; }

auth() {
  if [[ "${args[1]:-}" == "status" ]]; then
    printf 'github.com\n  ✓ Logged in to github.com account fake-test (keyring)\n'
    return 0
  fi
  unhandled
}

repo() {
  if [[ "${args[1]:-}" == "view" ]]; then
    printf 'name:	openharness\n'
    return 0
  fi
  unhandled
}

variable() {
  local name repo env slug file
  if [[ "${args[1]:-}" != "set" ]]; then
    unhandled
  fi
  name="${args[2]:-}"
  repo="$(gh_flag repo)"
  env="$(gh_flag env)"
  [[ -n "$env" ]] || env="_repository"
  slug="$(repo_slug "$repo")"
  file="$STATE/gh/variables/$slug/$env/$name"
  mkdir -p "$(dirname "$file")"
  printf '%s\n' "$(gh_flag body)" >"$file"
  printf '✓ Created variable %s for %s\n' "$name" "$slug"
}

api() {
  local url="" method=GET i rest repo env slug file
  for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[i]}" in
      --method) method="${args[i + 1]:-}" ;;
      --method=*) method="${args[i]#--method=}" ;;
      repos/*) url="${args[i]}" ;;
    esac
  done
  rest="${url#repos/}"
  case "$rest" in
    */environments/*)
      repo="${rest%%/environments/*}"
      env="${rest##*/environments/}"
      ;;
    *) unhandled ;;
  esac
  slug="$(repo_slug "$repo")"
  file="$STATE/gh/environments/$slug/$env"
  case "$method" in
    GET)
      if [[ ! -f "$file" ]]; then
        printf 'gh: Not Found (HTTP 404)\n' >&2
        exit 1
      fi
      printf '{"name":"%s","protection_rules":[]}\n' "$env"
      ;;
    PUT)
      mkdir -p "$(dirname "$file")"
      : >"$file"
      printf '%s\n' "$env"
      ;;
    *) unhandled ;;
  esac
}

case "${args[0]:-}" in
  auth) auth ;;
  repo) repo ;;
  variable) variable ;;
  api) api ;;
  *) unhandled ;;
esac
