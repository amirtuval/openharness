#!/usr/bin/env bash
#
# Automated check for .github/setup/workload-identity.sh (issue #161).
#
# The script must converge on re-run. This test proves the pieces of that:
#
#   1. a fresh run creates everything and exits 0; a second run exits 0 and makes no
#      create call at all (the fakes fail on creating what already exists, so a
#      regression here fails the run itself);
#   2. a changed attribute mapping is applied by update-oidc — no recreate — and the
#      next default run converges it back;
#   3. --prune removes a stale project role and a stale bucket binding of plan@ and a
#      foreign impersonator on plan@, while an unrelated member's binding and every
#      declared binding stay;
#   4. --dry-run makes no gcloud/gh call and leaves the state byte-identical.
#
# It runs the real script against stateful fake gcloud and gh (test/bin/), which keep
# what they are told to create in a temp directory and answer describe/get calls from
# it. No gcloud, gh, login or network is involved; bash and jq are (jq is what the
# script's --prune parses policies with). The same command runs on a developer machine
# and in CI (.github/workflows/setup-script.yml):
#
#   .github/setup/test/run-tests.sh
#
# The fake state layout — which this test seeds with the two hand-made projects and
# pokes to inject stale bindings — is documented at the top of test/bin/gcloud.sh.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../workload-identity.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required (the setup script's --prune parses IAM policies with it)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
STATE="$WORK/state"
BIN="$WORK/bin"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$STATE" "$BIN"
ln -s "$HERE/bin/gcloud.sh" "$BIN/gcloud"
ln -s "$HERE/bin/gh.sh" "$BIN/gh"
export FAKE_STATE_DIR="$STATE"
export PATH="$BIN:$PATH"

CALLS="$STATE/calls.log"
CHECKS=0
FAILURES=0

DEV=openharness-dev
PROD=openharness

pass() {
  CHECKS=$((CHECKS + 1))
  printf 'ok   - %s\n' "$1"
}

fail() {
  CHECKS=$((CHECKS + 1))
  FAILURES=$((FAILURES + 1))
  printf 'FAIL - %s\n' "$1" >&2
}

# --- assertions -------------------------------------------------------------

calls_count() {
  if [[ -f "$CALLS" ]]; then
    wc -l <"$CALLS" | tr -d ' '
  else
    printf '0'
  fi
}

# calls_since N — the log lines after the N calls that had already happened.
calls_since() {
  tail -n "+$(( $1 + 1 ))" "$CALLS"
}

# run_capture ARGS... — run the setup script; sets RUN_RC and RUN_OUT (stdout+stderr).
# Never fails the test itself.
run_capture() {
  if RUN_OUT="$("$SCRIPT" "$@" 2>&1)"; then
    RUN_RC=0
  else
    RUN_RC=$?
  fi
}

assert_rc() { # RC DESCRIPTION
  if [[ "$1" -eq 0 ]]; then
    pass "$2"
  else
    fail "$2 (exit $1)"
  fi
}

assert_contains() { # HAYSTACK NEEDLE DESCRIPTION
  if grep -qF -- "$2" <<<"$1"; then
    pass "$3"
  else
    fail "$3 — missing: $2"
  fi
}

assert_not_contains() { # HAYSTACK NEEDLE DESCRIPTION
  if grep -qF -- "$2" <<<"$1"; then
    fail "$3 — unexpected: $2"
  else
    pass "$3"
  fi
}

# assert_never_removed HAYSTACK MEMBER DESCRIPTION — no remove-iam-policy-binding line
# mentions MEMBER. (The member legitimately appears in the run's add commands; what must
# not happen is a removal for it.)
assert_never_removed() {
  if grep -F 'remove-iam-policy-binding' <<<"$1" | grep -qF -- "$2"; then
    fail "$3 — a removal mentions: $2"
  else
    pass "$3"
  fi
}

policy_has() { # FILE MEMBER ROLE
  jq -e --arg member "$2" --arg role "$3" \
    'any((.bindings // [])[]; .role == $role and ((.members // []) | index($member)))' \
    "$1" >/dev/null 2>&1
}

assert_binding() { # FILE MEMBER ROLE DESCRIPTION
  if policy_has "$1" "$2" "$3"; then
    pass "$4"
  else
    fail "$4 — binding gone: $3 for $2"
  fi
}

assert_no_binding() { # FILE MEMBER ROLE DESCRIPTION
  if [[ ! -f "$1" ]]; then
    fail "$4 — no policy file: $1"
  elif policy_has "$1" "$2" "$3"; then
    fail "$4 — binding still there: $3 for $2"
  else
    pass "$4"
  fi
}

# --- state fixtures ---------------------------------------------------------

# fresh_state — empty state plus the two hand-made projects: the README says the
# projects exist already, so only they are seeded (the fake tracks everything else the
# script creates). Distinct project numbers make the principalSets distinguishable.
fresh_state() {
  rm -rf "$STATE"
  mkdir -p "$STATE/projects"
  printf '111111111111\n' >"$STATE/projects/$DEV"
  printf '222222222222\n' >"$STATE/projects/$PROD"
}

# policy_inject FILE MEMBER ROLE — add a binding to a policy in the fake state, as an
# outside actor (or an earlier version of the script) would have left it.
policy_inject() {
  local file="$1" member="$2" role="$3" tmp
  mkdir -p "$(dirname "$file")"
  [[ -f "$file" ]] || printf '{"bindings": [], "etag": "injected"}\n' >"$file"
  tmp="$(mktemp)"
  jq --arg member "$member" --arg role "$role" \
    '.bindings = ((.bindings // []) + [{"role": $role, "members": [$member]}])' \
    "$file" >"$tmp"
  mv "$tmp" "$file"
}

# state_hash — a digest of the whole fake state, to prove a dry run changed nothing.
state_hash() {
  find "$STATE" -type f -exec sha256sum {} + | LC_ALL=C sort | sha256sum
}

# --- 1. fresh state, then a converging second run ---------------------------

echo "== 1. each environment: a fresh run, then a convergent second run"
fresh_state
run_capture staging
assert_rc "$RUN_RC" "staging: fresh run exits 0"
first="$(cat "$CALLS")"
assert_contains "$first" "iam workload-identity-pools create github" "staging: first run creates the pool"
assert_contains "$first" "iam workload-identity-pools providers create-oidc github" "staging: first run creates the OIDC provider"
assert_contains "$first" "iam service-accounts create deploy" "staging: first run creates deploy@"
assert_contains "$first" "iam service-accounts create plan" "staging: first run creates plan@"
assert_contains "$first" "storage buckets create gs://$DEV-tfstate" "staging: first run creates the state bucket"
assert_contains "$first" "gh api --method PUT repos/amirtuval/openharness/environments/staging" "staging: first run creates the GitHub environment"
assert_contains "$first" "gh variable set GCP_WIF_PROVIDER" "staging: first run sets the GitHub variables"
assert_not_contains "$first" "update-oidc" "staging: first run has nothing to update"

before="$(calls_count)"
run_capture staging
assert_rc "$RUN_RC" "staging: second run exits 0"
second="$(calls_since "$before")"
assert_not_contains "$second" "create" "staging: second run makes no create call at all"
assert_contains "$second" "iam workload-identity-pools update github" "staging: second run converges the pool"
assert_contains "$second" "iam workload-identity-pools providers update-oidc github" "staging: second run converges the provider"
assert_contains "$second" "iam service-accounts update deploy@$DEV.iam.gserviceaccount.com" "staging: second run converges deploy@"
assert_contains "$second" "iam service-accounts update plan@$DEV.iam.gserviceaccount.com" "staging: second run converges plan@"
assert_contains "$second" "storage buckets update gs://$DEV-tfstate" "staging: second run re-applies the bucket settings"
assert_not_contains "$second" "--method PUT" "staging: second run leaves the GitHub environment alone"

before="$(calls_count)"
run_capture production
assert_rc "$RUN_RC" "production: fresh run exits 0"
prod_first="$(calls_since "$before")"
assert_contains "$prod_first" "iam workload-identity-pools providers create-oidc github" "production: first run creates its own provider"
assert_contains "$prod_first" "storage buckets create gs://$PROD-tfstate" "production: first run creates its own state bucket"
assert_not_contains "$prod_first" "$DEV" "production: run touches no staging resource"

before="$(calls_count)"
run_capture production
assert_rc "$RUN_RC" "production: second run exits 0"
assert_not_contains "$(calls_since "$before")" "create" "production: second run makes no create call at all"

# --- 2. a changed attribute mapping converges --------------------------------

echo
echo "== 2. a changed attribute mapping is applied by update-oidc"
before="$(calls_count)"
export WIF_ATTRIBUTE_MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name,attribute.workflow=assertion.workflow"
run_capture staging
unset WIF_ATTRIBUTE_MAPPING
assert_rc "$RUN_RC" "mapping change: run exits 0"
mapping="$(calls_since "$before")"
assert_contains "$mapping" "iam workload-identity-pools providers update-oidc github" "mapping change goes through update-oidc"
assert_contains "$mapping" "attribute.workflow=assertion.workflow" "update-oidc is called with the new mapping"
assert_not_contains "$mapping" "create-oidc" "the provider is not recreated"
provider_file="$STATE/providers/$DEV/github/github.json"
assert_contains "$(cat "$provider_file")" "attribute.workflow=assertion.workflow" "the provider state holds the new mapping"

before="$(calls_count)"
run_capture staging
assert_rc "$RUN_RC" "mapping restore: run exits 0"
assert_not_contains "$(calls_since "$before")" "attribute.workflow=assertion.workflow" "the next default run converges the mapping back"

# --- 3. --prune removes only the managed accounts' stale bindings ------------

echo
echo "== 3. --prune removes only the managed accounts' stale bindings"
deploy_member="serviceAccount:deploy@$DEV.iam.gserviceaccount.com"
plan_member="serviceAccount:plan@$DEV.iam.gserviceaccount.com"
outsider="user:someone@example.com"
deploy_ps="principalSet://iam.googleapis.com/projects/111111111111/locations/global/workloadIdentityPools/github/attribute.environment/staging"
plan_ps="principalSet://iam.googleapis.com/projects/111111111111/locations/global/workloadIdentityPools/github/attribute.event_name/pull_request"
foreign_ps="principalSet://iam.googleapis.com/projects/999999999999/locations/global/workloadIdentityPools/github/attribute.repository/someone/else"

project_policy="$STATE/policies/project-$DEV.json"
bucket_policy="$STATE/policies/bucket-$DEV-tfstate.json"
deploy_sa_policy="$STATE/policies/sa-deploy@$DEV.iam.gserviceaccount.com.json"
plan_sa_policy="$STATE/policies/sa-plan@$DEV.iam.gserviceaccount.com.json"

policy_inject "$project_policy" "$plan_member" "roles/editor"
policy_inject "$project_policy" "$outsider" "roles/editor"
policy_inject "$bucket_policy" "$plan_member" "roles/storage.objectViewer"
policy_inject "$bucket_policy" "$deploy_member" "roles/storage.objectViewer"
policy_inject "$plan_sa_policy" "$foreign_ps" "roles/iam.workloadIdentityUser"

before="$(calls_count)"
run_capture staging --prune
assert_rc "$RUN_RC" "prune: run exits 0"
pruned="$(calls_since "$before")"
assert_contains "$pruned" "projects remove-iam-policy-binding $DEV --member=$plan_member --role=roles/editor --all" "prune removes plan@'s stale project role"
assert_contains "$pruned" "remove-iam-policy-binding gs://$DEV-tfstate --member=$plan_member --role=roles/storage.objectViewer --all" "prune removes plan@'s stale bucket role"
assert_contains "$pruned" "remove-iam-policy-binding gs://$DEV-tfstate --member=$deploy_member --role=roles/storage.objectViewer --all" "prune removes deploy@'s bucket binding (deploy@ declares none)"
assert_contains "$pruned" "iam service-accounts remove-iam-policy-binding plan@$DEV.iam.gserviceaccount.com" "prune removes the foreign impersonator from plan@"
assert_not_contains "$pruned" "$outsider" "prune never touches another member's binding"
assert_never_removed "$pruned" "$plan_ps" "prune removes nothing from plan@'s declared principalSet"
assert_never_removed "$pruned" "$deploy_ps" "prune removes nothing from deploy@'s declared principalSet"
assert_contains "$RUN_OUT" "remove roles/editor from $plan_member" "prune prints each removal"

assert_no_binding "$project_policy" "$plan_member" "roles/editor" "prune dropped plan@'s stale project role"
assert_binding "$project_policy" "$plan_member" "roles/viewer" "plan@ keeps roles/viewer"
assert_binding "$project_policy" "$plan_member" "roles/iam.securityReviewer" "plan@ keeps roles/iam.securityReviewer"
assert_binding "$project_policy" "$outsider" "roles/editor" "another member's binding is untouched"
assert_binding "$project_policy" "$deploy_member" "roles/owner" "deploy@ keeps roles/owner"
assert_no_binding "$bucket_policy" "$plan_member" "roles/storage.objectViewer" "prune dropped plan@'s stale bucket role"
assert_binding "$bucket_policy" "$plan_member" "roles/storage.objectAdmin" "plan@ keeps its declared bucket role"
assert_no_binding "$bucket_policy" "$deploy_member" "roles/storage.objectViewer" "prune dropped deploy@'s undeclared bucket role"
assert_no_binding "$plan_sa_policy" "$foreign_ps" "roles/iam.workloadIdentityUser" "prune dropped the foreign impersonator"
assert_binding "$plan_sa_policy" "$plan_ps" "roles/iam.workloadIdentityUser" "plan@ keeps its declared principalSet"
assert_binding "$deploy_sa_policy" "$deploy_ps" "roles/iam.workloadIdentityUser" "deploy@'s declared principalSet is untouched"

# --- 4. --dry-run executes nothing ------------------------------------------

echo
echo "== 4. --dry-run makes no call and no state change"
before_calls="$(calls_count)"
before_hash="$(state_hash)"
run_capture production --dry-run --prune
assert_rc "$RUN_RC" "dry run: exits 0"
assert_contains "$RUN_OUT" "Prune (--dry-run)" "dry run prints the prune plan"
assert_contains "$RUN_OUT" "Dry run only: nothing above was executed." "dry run says nothing ran"
assert_contains "$RUN_OUT" "<project-number>" "dry run shows the unknown project number as a placeholder"
if [[ "$(calls_count)" -eq "$before_calls" ]]; then
  pass "dry run made no gcloud or gh call"
else
  fail "dry run made calls: $(calls_since "$before_calls")"
fi
if [[ "$(state_hash)" == "$before_hash" ]]; then
  pass "dry run changed no state"
else
  fail "dry run changed the state"
fi

# --- summary ----------------------------------------------------------------

echo
if [[ "$FAILURES" -eq 0 ]]; then
  printf 'All %d checks passed.\n' "$CHECKS"
else
  printf '%d of %d checks failed.\n' "$FAILURES" "$CHECKS" >&2
  exit 1
fi
