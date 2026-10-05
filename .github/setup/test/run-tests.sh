#!/usr/bin/env bash
#
# Automated check for .github/setup/workload-identity.sh (issues #161, #167).
#
# The script must converge on re-run, and deploy@ must hold least privilege. This test
# proves the pieces of that:
#
#   1. a fresh run creates everything and exits 0; a second run exits 0 and makes no
#      create call at all (the fakes fail on creating what already exists, so a
#      regression here fails the run itself);
#   2. a changed attribute mapping is applied by update-oidc — no recreate — and the
#      next default run converges it back;
#   3. deploy@ never gets roles/owner; staging carries roles/artifactregistry.admin and
#      production does not; the conditional roles/resourcemanager.projectIamAdmin binding
#      exists exactly once per environment and carries the terraform-grantable-roles
#      condition built from the grantable list; production's deploy account can read
#      staging's Artifact Registry and nothing else there;
#   4. --prune removes a stray roles/owner from deploy@, a stale project role and bucket
#      bindings of tf-plan@, and a foreign impersonator on tf-plan@, while an unrelated
#      member's binding and every declared binding — the conditional one included — stay;
#      a production --prune touches openharness-dev only for deploy@ of the production
#      project (whose ID is openharness-510710);
#   5. a conditional binding whose condition changed is removed with its own condition
#      and replaced by the run's grant — replaced, not doubled — and a converged re-run
#      removes nothing;
#   6. --dry-run makes no gcloud/gh call, leaves the state byte-identical, and still
#      prints the conditional binding's condition file and the cross-project grant.
#
# It runs the real script against stateful fake gcloud and gh (test/bin/), which keep
# what they are told to create in a temp directory and answer describe/get calls from
# it. No gcloud, gh, login or network is involved; bash and jq are (jq is what the
# script builds the condition file with and parses policies with). The same command runs
# on a developer machine and in CI (.github/workflows/setup-script.yml):
#
#   .github/setup/test/run-tests.sh
#
# The fake state layout — which this test seeds with the two hand-made projects and
# pokes to inject stale bindings — is documented at the top of test/bin/gcloud.sh.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../workload-identity.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required (the setup script builds its condition file and parses IAM policies with it)" >&2
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
# Production's project *ID*. Its display name is "openharness", which is what the script
# used to be given; only the ID works with gcloud. The fixture pins the ID so a regression
# back to the display name fails here.
PROD=openharness-510710

# The roles deploy@ may hand out (#167). The test owns this expectation: the condition
# expression on the conditional binding must list exactly these.
GRANTABLE_ROLES=(
  roles/logging.logWriter
  roles/monitoring.metricWriter
  roles/monitoring.viewer
  roles/stackdriver.resourceMetadata.writer
  roles/cloudtrace.agent
  roles/cloudsql.client
  roles/cloudsql.instanceUser
  roles/container.defaultNodeServiceAccount
  roles/artifactregistry.reader
)

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

# assert_only_lines HAYSTACK MENTIONED PATTERN DESCRIPTION — every line of HAYSTACK that
# mentions MENTIONED also contains PATTERN.
assert_only_lines() {
  if grep -F -- "$2" <<<"$1" | grep -vFq -- "$3"; then
    fail "$4 — unexpected: $(grep -F -- "$2" <<<"$1" | grep -vF -- "$3" | head -1)"
  else
    pass "$4"
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

# assert_no_owner_added DESCRIPTION — no add-iam-policy-binding call ever names
# roles/owner. Owner is never granted, whatever else the log holds.
assert_no_owner_added() {
  if grep -F 'add-iam-policy-binding' "$CALLS" | grep -qF 'roles/owner'; then
    fail "$1 — a grant uses roles/owner"
  else
    pass "$1"
  fi
}

policy_has() { # FILE MEMBER ROLE
  jq -e --arg member "$2" --arg role "$3" \
    'any((.bindings // [])[]; .role == $role and ((.members // []) | index($member)))' \
    "$1" >/dev/null 2>&1
}

# policy_binding_count FILE MEMBER ROLE — how many bindings the policy holds for MEMBER
# and ROLE, one per condition. The count is what catches a duplicated conditional
# binding.
policy_binding_count() {
  jq --arg member "$2" --arg role "$3" \
    '[ (.bindings // [])[]
       | select(.role == $role and ((.members // []) | index($member))) ] | length' \
    "$1" 2>/dev/null || printf '0'
}

# policy_condition FILE MEMBER ROLE — the condition of the first binding for MEMBER and
# ROLE as compact JSON ('null' when it is unconditional, 'absent' when there is no such
# binding).
policy_condition() {
  jq -c --arg member "$2" --arg role "$3" '
    [ (.bindings // [])[]
      | select(.role == $role and ((.members // []) | index($member))) ] as $found
    | if ($found | length) == 0 then "absent" else ($found[0].condition // null) end
  ' "$1" 2>/dev/null || printf 'absent'
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

# policy_inject FILE MEMBER ROLE [CONDITION_JSON] — add a binding to a policy in the fake
# state, as an outside actor (or an earlier version of the script) would have left it.
# CONDITION_JSON is the condition to attach; the default leaves the binding
# unconditional.
policy_inject() {
  local file="$1" member="$2" role="$3" condition="${4:-null}" tmp
  mkdir -p "$(dirname "$file")"
  [[ -f "$file" ]] || printf '{"bindings": [], "etag": "injected"}\n' >"$file"
  tmp="$(mktemp)"
  jq --arg member "$member" --arg role "$role" --argjson condition "$condition" \
    '.bindings = ((.bindings // []) + [
       if $condition == null
       then {"role": $role, "members": [$member]}
       else {"role": $role, "members": [$member], "condition": $condition} end
     ])' \
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
assert_contains "$first" "iam service-accounts create tf-plan" "staging: first run creates tf-plan@"
assert_contains "$first" "storage buckets create gs://$DEV-tfstate" "staging: first run creates the state bucket"
assert_contains "$first" "gh api --method PUT repos/amirtuval/openharness/environments/staging" "staging: first run creates the GitHub environment"
assert_contains "$first" "gh variable set GCP_WIF_PROVIDER" "staging: first run sets the GitHub variables"
assert_not_contains "$first" "update-oidc" "staging: first run has nothing to update"
assert_not_contains "$first" "deploy@$PROD.iam.gserviceaccount.com" "staging: run never touches production's deploy account"

before="$(calls_count)"
run_capture staging
assert_rc "$RUN_RC" "staging: second run exits 0"
second="$(calls_since "$before")"
assert_not_contains "$second" "create" "staging: second run makes no create call at all"
assert_contains "$second" "iam workload-identity-pools update github" "staging: second run converges the pool"
assert_contains "$second" "iam workload-identity-pools providers update-oidc github" "staging: second run converges the provider"
assert_contains "$second" "iam service-accounts update deploy@$DEV.iam.gserviceaccount.com" "staging: second run converges deploy@"
assert_contains "$second" "iam service-accounts update tf-plan@$DEV.iam.gserviceaccount.com" "staging: second run converges tf-plan@"
assert_contains "$second" "storage buckets update gs://$DEV-tfstate" "staging: second run re-applies the bucket settings"
assert_not_contains "$second" "--method PUT" "staging: second run leaves the GitHub environment alone"

before="$(calls_count)"
run_capture production
assert_rc "$RUN_RC" "production: fresh run exits 0"
prod_first="$(calls_since "$before")"
assert_contains "$prod_first" "iam workload-identity-pools providers create-oidc github" "production: first run creates its own provider"
assert_contains "$prod_first" "storage buckets create gs://$PROD-tfstate" "production: first run creates its own state bucket"
assert_contains "$prod_first" "projects add-iam-policy-binding $DEV --member=serviceAccount:deploy@$PROD.iam.gserviceaccount.com --role=roles/artifactregistry.reader --condition=None" "production: run grants its cross-project Artifact Registry read on staging"
assert_only_lines "$prod_first" "$DEV" "add-iam-policy-binding $DEV --member=serviceAccount:deploy@$PROD.iam.gserviceaccount.com --role=roles/artifactregistry.reader" "production: touches no staging resource but the cross-project grant"

# The production project ID, pinned as literals: the display name "openharness" is not a
# project ID and does not exist, so a regression to it has to fail here.
assert_contains "$prod_first" "projects add-iam-policy-binding openharness-510710 --member=serviceAccount:deploy@openharness-510710.iam.gserviceaccount.com" "production: run targets project ID openharness-510710"
assert_contains "$prod_first" "storage buckets create gs://openharness-510710-tfstate" "production: state bucket is gs://openharness-510710-tfstate"

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

# --- 3. least privilege: no Owner, staging-only registry, the conditional grant ---

echo
echo "== 3. least privilege: no Owner, staging-only registry, one conditional binding"
deploy_member="serviceAccount:deploy@$DEV.iam.gserviceaccount.com"
plan_member="serviceAccount:tf-plan@$DEV.iam.gserviceaccount.com"
deploy_prod_member="serviceAccount:deploy@$PROD.iam.gserviceaccount.com"
conditional_role="roles/resourcemanager.projectIamAdmin"
dev_policy="$STATE/policies/project-$DEV.json"
prod_policy="$STATE/policies/project-$PROD.json"

assert_no_owner_added "no run grants roles/owner"

assert_no_binding "$dev_policy" "$deploy_member" "roles/owner" "staging: deploy@ holds no roles/owner"
assert_binding "$dev_policy" "$deploy_member" "roles/serviceusage.serviceUsageAdmin" "staging: deploy@ holds the declared Terraform roles"
assert_binding "$dev_policy" "$deploy_member" "roles/browser" "staging: deploy@ holds roles/browser"
assert_binding "$dev_policy" "$deploy_member" "roles/artifactregistry.admin" "staging: deploy@ holds artifactregistry.admin"
assert_no_binding "$prod_policy" "$deploy_prod_member" "roles/artifactregistry.admin" "production: deploy@ does not hold artifactregistry.admin"
assert_binding "$prod_policy" "$deploy_prod_member" "roles/cloudsql.admin" "production: deploy@ holds a declared Terraform role"
assert_binding "$prod_policy" "$deploy_prod_member" "roles/monitoring.editor" "production: deploy@ holds roles/monitoring.editor"

for member_policy in "$dev_policy|$deploy_member" "$prod_policy|$deploy_prod_member"; do
  policy_file="${member_policy%%|*}"
  policy_member="${member_policy#*|}"
  count="$(policy_binding_count "$policy_file" "$policy_member" "$conditional_role")"
  if [[ "$count" == "1" ]]; then
    pass "$(basename "$policy_file"): the conditional binding exists exactly once"
  else
    fail "$(basename "$policy_file"): expected one conditional binding, found $count"
  fi
done

condition="$(policy_condition "$dev_policy" "$deploy_member" "$conditional_role")"
assert_contains "$condition" '"title":"terraform-grantable-roles"' "the conditional binding carries the terraform-grantable-roles title"
expression="$(jq -r '.expression' <<<"$condition")"
assert_contains "$expression" "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([" "the condition limits grants through modifiedGrantsByRole"
assert_not_contains "$expression" "roles/owner" "the grantable list holds no roles/owner"
for grantable in "${GRANTABLE_ROLES[@]}"; do
  assert_contains "$expression" "'$grantable'" "the condition allows $grantable"
done

assert_binding "$dev_policy" "$deploy_prod_member" "roles/artifactregistry.reader" "production: deploy@$PROD reads staging's Artifact Registry"
assert_no_binding "$dev_policy" "$deploy_prod_member" "roles/artifactregistry.admin" "production: deploy@$PROD holds no admin there"

# --- 4. --prune removes only the managed accounts' stale bindings ------------

echo
echo "== 4. --prune removes only the managed accounts' stale bindings (staging)"
outsider="user:someone@example.com"
deploy_ps="principalSet://iam.googleapis.com/projects/111111111111/locations/global/workloadIdentityPools/github/attribute.environment/staging"
plan_ps="principalSet://iam.googleapis.com/projects/111111111111/locations/global/workloadIdentityPools/github/attribute.event_name/pull_request"
foreign_ps="principalSet://iam.googleapis.com/projects/999999999999/locations/global/workloadIdentityPools/github/attribute.repository/someone/else"

bucket_policy="$STATE/policies/bucket-$DEV-tfstate.json"
deploy_sa_policy="$STATE/policies/sa-deploy@$DEV.iam.gserviceaccount.com.json"
plan_sa_policy="$STATE/policies/sa-tf-plan@$DEV.iam.gserviceaccount.com.json"

policy_inject "$dev_policy" "$deploy_member" "roles/owner"
policy_inject "$dev_policy" "$plan_member" "roles/editor"
policy_inject "$dev_policy" "$outsider" "roles/editor"
policy_inject "$bucket_policy" "$plan_member" "roles/storage.objectViewer"
policy_inject "$bucket_policy" "$deploy_member" "roles/storage.objectViewer"
policy_inject "$plan_sa_policy" "$foreign_ps" "roles/iam.workloadIdentityUser"

before="$(calls_count)"
run_capture staging --prune
assert_rc "$RUN_RC" "prune: run exits 0"
pruned="$(calls_since "$before")"
assert_contains "$pruned" "projects remove-iam-policy-binding $DEV --member=$deploy_member --role=roles/owner --condition=None" "prune removes deploy@'s stray roles/owner"
assert_contains "$pruned" "projects remove-iam-policy-binding $DEV --member=$plan_member --role=roles/editor --condition=None" "prune removes tf-plan@'s stale project role"
assert_contains "$pruned" "remove-iam-policy-binding gs://$DEV-tfstate --member=$plan_member --role=roles/storage.objectViewer --condition=None" "prune removes tf-plan@'s stale bucket role"
assert_contains "$pruned" "remove-iam-policy-binding gs://$DEV-tfstate --member=$deploy_member --role=roles/storage.objectViewer --condition=None" "prune removes deploy@'s undeclared bucket role"
assert_contains "$pruned" "iam service-accounts remove-iam-policy-binding tf-plan@$DEV.iam.gserviceaccount.com" "prune removes the foreign impersonator from tf-plan@"
assert_not_contains "$pruned" "$outsider" "prune never touches another member's binding"
assert_never_removed "$pruned" "$plan_ps" "prune removes nothing from tf-plan@'s declared principalSet"
assert_never_removed "$pruned" "$deploy_ps" "prune removes nothing from deploy@'s declared principalSet"
assert_contains "$RUN_OUT" "remove roles/owner from $deploy_member" "prune prints each removal"
assert_contains "$RUN_OUT" "remove roles/editor from $plan_member" "prune prints the stale tf-plan@ role too"

assert_no_binding "$dev_policy" "$deploy_member" "roles/owner" "prune dropped deploy@'s stray roles/owner"
assert_no_binding "$dev_policy" "$plan_member" "roles/editor" "prune dropped tf-plan@'s stale project role"
assert_binding "$dev_policy" "$plan_member" "roles/viewer" "tf-plan@ keeps roles/viewer"
assert_binding "$dev_policy" "$plan_member" "roles/iam.securityReviewer" "tf-plan@ keeps roles/iam.securityReviewer"
assert_binding "$dev_policy" "$outsider" "roles/editor" "another member's binding is untouched"
assert_binding "$dev_policy" "$deploy_member" "roles/cloudsql.admin" "deploy@ keeps a declared role"
assert_binding "$dev_policy" "$deploy_member" "roles/artifactregistry.admin" "deploy@ keeps the staging-only role"
assert_no_binding "$bucket_policy" "$plan_member" "roles/storage.objectViewer" "prune dropped tf-plan@'s stale bucket role"
assert_binding "$bucket_policy" "$plan_member" "roles/storage.objectAdmin" "tf-plan@ keeps its declared bucket role"
assert_binding "$bucket_policy" "$deploy_member" "roles/storage.objectAdmin" "deploy@ keeps its declared bucket role"
assert_no_binding "$bucket_policy" "$deploy_member" "roles/storage.objectViewer" "prune dropped deploy@'s undeclared bucket role"
assert_no_binding "$plan_sa_policy" "$foreign_ps" "roles/iam.workloadIdentityUser" "prune dropped the foreign impersonator"
assert_binding "$plan_sa_policy" "$plan_ps" "roles/iam.workloadIdentityUser" "tf-plan@ keeps its declared principalSet"
assert_binding "$deploy_sa_policy" "$deploy_ps" "roles/iam.workloadIdentityUser" "deploy@'s declared principalSet is untouched"
assert_contains "$(policy_condition "$dev_policy" "$deploy_member" "$conditional_role")" "hasOnly(['roles/logging.logWriter'" "prune keeps the declared conditional binding"
assert_not_contains "$pruned" "remove-iam-policy-binding $DEV --member=$deploy_member --role=$conditional_role" "prune removes nothing for the declared conditional binding"

# --- 5. a production --prune touches staging only for its own member ---------

echo
echo "== 5. --prune on production touches openharness-dev only for its own member"
policy_inject "$dev_policy" "$deploy_prod_member" "roles/viewer"
policy_inject "$dev_policy" "$outsider" "roles/editor"
policy_inject "$dev_policy" "$plan_member" "roles/editor"

before="$(calls_count)"
run_capture production --prune
assert_rc "$RUN_RC" "production prune: run exits 0"
prod_pruned="$(calls_since "$before")"
assert_contains "$prod_pruned" "projects remove-iam-policy-binding $DEV --member=$deploy_prod_member --role=roles/viewer --condition=None" "production prune drops deploy@$PROD's undeclared role on staging"
assert_not_contains "$prod_pruned" "remove-iam-policy-binding $DEV --member=$outsider" "production prune leaves another member's binding on staging alone"
assert_not_contains "$prod_pruned" "remove-iam-policy-binding $DEV --member=$plan_member" "production prune leaves staging's own accounts alone"
assert_binding "$dev_policy" "$deploy_prod_member" "roles/artifactregistry.reader" "production keeps its cross-project reader"
assert_no_binding "$dev_policy" "$deploy_prod_member" "roles/viewer" "the undeclared cross-project role is gone"
assert_binding "$dev_policy" "$outsider" "roles/editor" "the outsider's staging binding is untouched"
assert_binding "$dev_policy" "$plan_member" "roles/editor" "tf-plan@openharness-dev's binding is not production's to prune"

# --- 6. a changed condition is replaced, not doubled -------------------------

echo
echo "== 6. a changed condition is replaced on re-run, not doubled"
old_condition="$(jq -c -n \
  --arg expression "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/owner'])" \
  --arg title "terraform-grantable-roles" \
  --arg description "the old, unrestricted list" \
  '{expression: $expression, title: $title, description: $description}')"
policy_inject "$dev_policy" "$deploy_member" "$conditional_role" "$old_condition"

before="$(calls_count)"
run_capture staging --prune
assert_rc "$RUN_RC" "changed condition: run exits 0"
changed="$(calls_since "$before")"
assert_contains "$changed" "projects remove-iam-policy-binding $DEV --member=$deploy_member --role=$conditional_role --condition-from-file=" "the stale conditional binding is removed with its own condition"

count="$(policy_binding_count "$dev_policy" "$deploy_member" "$conditional_role")"
if [[ "$count" == "1" ]]; then
  pass "changed condition: exactly one conditional binding remains"
else
  fail "changed condition: expected one conditional binding, found $count"
fi
expression="$(policy_condition "$dev_policy" "$deploy_member" "$conditional_role" | jq -r '.expression')"
assert_contains "$expression" "hasOnly(['roles/logging.logWriter'" "the surviving binding carries the declared condition"
assert_not_contains "$expression" "roles/owner" "the stale condition is gone, replaced — not doubled"

before="$(calls_count)"
run_capture staging --prune
assert_rc "$RUN_RC" "changed condition: converged re-run exits 0"
assert_not_contains "$(calls_since "$before")" "remove-iam-policy-binding $DEV --member=$deploy_member --role=$conditional_role" "a converged re-run removes nothing for the conditional binding"
count="$(policy_binding_count "$dev_policy" "$deploy_member" "$conditional_role")"
if [[ "$count" == "1" ]]; then
  pass "changed condition: the converged re-run duplicates nothing"
else
  fail "changed condition: expected one conditional binding after the re-run, found $count"
fi

# --- 7. --dry-run executes nothing ------------------------------------------

echo
echo "== 7. --dry-run makes no call and no state change"
before_calls="$(calls_count)"
before_hash="$(state_hash)"
run_capture production --dry-run --prune
assert_rc "$RUN_RC" "dry run: exits 0"
assert_contains "$RUN_OUT" "Prune (--dry-run)" "dry run prints the prune plan"
assert_contains "$RUN_OUT" "Dry run only: nothing above was executed." "dry run says nothing ran"
assert_contains "$RUN_OUT" "<project-number>" "dry run shows the unknown project number as a placeholder"
assert_contains "$RUN_OUT" "'--role=roles/resourcemanager.projectIamAdmin' '--condition-from-file=" "dry run shows the conditional binding"
assert_contains "$RUN_OUT" "hasOnly(['roles/logging.logWriter'" "dry run prints the condition file's content"
assert_contains "$RUN_OUT" "'add-iam-policy-binding' 'openharness-dev' '--member=serviceAccount:deploy@$PROD.iam.gserviceaccount.com' '--role=roles/artifactregistry.reader'" "dry run shows the production cross-project grant"
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
