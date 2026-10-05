#!/usr/bin/env bash
#
# Workload Identity Federation setup for openharness (issue #149, epic #148, D3; #161).
#
# The maintainer runs this once per GCP project, with their own gcloud credentials, before
# the first Terraform apply. GitHub Actions cannot create its own Workload Identity — the
# identity it would use to create it does not exist yet — so this is the one piece of the
# deployment that is not Terraform.
#
# Idempotent by design (#161): everything the script owns is declared in the lists at the
# top, and a re-run converges the project to them — it creates what is missing, updates
# what exists already (pool, provider and service accounts), and re-applies the settings
# it owns. To need a new API, role or service, edit a list and re-run. The default run is
# additive; --prune additionally removes the managed accounts' bindings that the lists no
# longer declare.
#
# `--dry-run` prints every gcloud and gh command without running them; that mode needs no
# gcloud, gh or login at all. It executes nothing, so it cannot list the exact bindings
# --prune would remove — reading those needs the live policies.
#
# Usage:
#   ./.github/setup/workload-identity.sh staging [--repo OWNER/REPO] [--dry-run]
#   ./.github/setup/workload-identity.sh production --deploy-roles=narrow --prune
#
# Prerequisites, what it creates, role choices and how to undo it: README.md next to this
# script.

set -euo pipefail

# ---------------------------------------------------------------------------
# Declarative lists (issue #161). Everything this script owns is here: to add
# an API, a role or a service, edit a list and re-run — nothing else in the
# script needs touching. The binding loops below iterate these arrays.
# ---------------------------------------------------------------------------

# The APIs Workload Identity and Terraform need to start. Terraform enables the rest (D4).
APIS=(
  iam.googleapis.com
  iamcredentials.googleapis.com
  sts.googleapis.com
  cloudresourcemanager.googleapis.com
  serviceusage.googleapis.com
  storage.googleapis.com
)

# Project roles for the deploy account (deploy@). Owner is the default; the rationale and
# the risk are in README.md ("Role choices and risk").
DEPLOY_PROJECT_ROLES=(
  roles/owner
)

# The narrower alternative for deploy@, chosen with --deploy-roles=narrow. It has to stay
# in sync as Terraform grows, and it cannot cover the billing budgets (D4): they live on
# the billing account, so whichever identity creates them needs a grant there, which no
# project-level role gives — Owner included. See README.md.
DEPLOY_PROJECT_ROLES_NARROW=(
  roles/serviceusage.serviceUsageAdmin
  roles/iam.serviceAccountAdmin
  roles/resourcemanager.projectIamAdmin
  roles/storage.admin
  roles/artifactregistry.admin
  roles/compute.admin
  roles/container.admin
  roles/cloudsql.admin
  roles/secretmanager.admin
  roles/cloudkms.admin
  roles/dns.admin
  roles/monitoring.admin
  roles/logging.admin
)

# Project roles for the plan account (tf-plan@). Viewer reads most of the project;
# securityReviewer adds read-only IAM policy reads, which a plan that refreshes IAM
# resources needs. Both are read-only.
PLAN_PROJECT_ROLES=(
  roles/viewer
  roles/iam.securityReviewer
)

# The plan account's rights on the state bucket only: read the state and take the lock
# (the create/delete of the .tflock object). The deploy account is declared nothing on
# the bucket, and --prune removes any binding it finds there.
PLAN_STATE_BUCKET_ROLES=(
  roles/storage.objectAdmin
)

# Fixed names from the deployment epic (#148, D3).
POOL_ID="github"
PROVIDER_ID="github"
ISSUER_URI="https://token.actions.githubusercontent.com"
LOCATION="global" # workload identity pools and providers are always global
REGION="us-central1"

REPO="amirtuval/openharness"
ENVIRONMENT=""
DRY_RUN=false
PRUNE=false
DEPLOY_ROLES_MODE="owner"

usage() {
  cat <<'EOF'
Usage: workload-identity.sh <staging|production> [options]

  staging       set up project openharness-dev
  production    set up project openharness

Options:
  --repo OWNER/REPO    this repository (default: amirtuval/openharness)
  --deploy-roles=MODE  project roles for the deploy account: owner (default) or narrow
  --prune              also remove the managed accounts' bindings that are not in the
                       script's lists (project, state bucket and impersonation bindings)
  --dry-run            print every gcloud and gh command without running it
  -h, --help           show this help and exit

Prerequisites and what the script creates: see README.md next to it.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    staging | production)
      [[ -z "$ENVIRONMENT" ]] || fail "the environment was given twice ('$ENVIRONMENT' and '$1')"
      ENVIRONMENT="$1"
      shift
      ;;
    --repo)
      [[ $# -ge 2 ]] || fail '--repo needs OWNER/REPO'
      REPO="$2"
      shift 2
      ;;
    --repo=*)
      REPO="${1#--repo=}"
      shift
      ;;
    --deploy-roles)
      [[ $# -ge 2 ]] || fail '--deploy-roles needs owner or narrow'
      DEPLOY_ROLES_MODE="$2"
      shift 2
      ;;
    --deploy-roles=*)
      DEPLOY_ROLES_MODE="${1#--deploy-roles=}"
      shift
      ;;
    --prune)
      PRUNE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ -z "$ENVIRONMENT" ]]; then
  usage >&2
  fail "the environment is required (staging or production)"
fi
case "$REPO" in
  */*) ;;
  *) fail "--repo must be OWNER/REPO, got '$REPO'" ;;
esac

# Pick the deploy project-roles list (#161): the default list is already the owner one,
# so only 'narrow' swaps it for the alternative declared above.
case "$DEPLOY_ROLES_MODE" in
  owner) ;;
  narrow) DEPLOY_PROJECT_ROLES=("${DEPLOY_PROJECT_ROLES_NARROW[@]}") ;;
  *) fail "--deploy-roles must be owner or narrow, got '$DEPLOY_ROLES_MODE'" ;;
esac

case "$ENVIRONMENT" in
  staging) PROJECT_ID="openharness-dev" ;;
  production) PROJECT_ID="openharness" ;;
esac

# Service account IDs must be 6-30 characters ([a-z][a-z0-9-]{4,28}[a-z0-9]).
SA_DEPLOY_ID="deploy"
SA_PLAN_ID="tf-plan"
SA_DEPLOY="${SA_DEPLOY_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
SA_PLAN="${SA_PLAN_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
STATE_BUCKET="${PROJECT_ID}-tfstate"
ENV_SUFFIX="$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')"

SA_DEPLOY_DISPLAY="Terraform deploy (GitHub Actions)"
SA_DEPLOY_DESCRIPTION="Terraform apply for ${ENVIRONMENT} (epic #148, D3)"
SA_PLAN_DISPLAY="Terraform plan (GitHub Actions PRs)"
SA_PLAN_DESCRIPTION="Read-only terraform plan for PRs (epic #148, D3)"

# The provider's claim mapping, and the condition that pins the whole pool to this
# repository. A re-run converges an existing provider to these (#161). The two
# WIF_* environment variables are the seam the test drives (and a one-off migration can
# use) to converge a provider to a different mapping; the defaults are what the
# deployment declares.
ATTRIBUTE_MAPPING="${WIF_ATTRIBUTE_MAPPING:-google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name}"
# shellcheck disable=SC2016  # the single quotes are part of the condition expression
ATTRIBUTE_CONDITION="${WIF_ATTRIBUTE_CONDITION:-assertion.repository == '$REPO'}"

# Resolved from the project below; in a dry run there is no gcloud to ask, so it stays a
# placeholder.
PROJECT_NUMBER=""

# Print the arguments, shell-quoted, as a command line.
quote_args() {
  local arg quoted
  for arg in "$@"; do
    quoted=${arg//\'/\'\\\'\'}
    printf "'%s' " "$quoted"
  done
}

# Every gcloud and gh call goes through run: execute it, or — with --dry-run — print it.
run() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '+ '
    quote_args "$@"
    printf '\n'
  else
    "$@"
  fi
}

# True when the resource does not exist yet. Only ever used on read-only describe/GET
# commands. In a dry run every check answers "missing", so the printed plan is the full
# setup for a fresh project.
is_missing() {
  if [[ "$DRY_RUN" == true ]]; then
    return 0
  fi
  ! "$@" >/dev/null 2>&1
}

section() {
  printf '\n== %s\n' "$*"
}

# Set one variable in the GitHub environment, and the suffixed copy at repository level:
# PR plans run outside any environment (D8, terraform-pr.yml), so they cannot read the
# environment-scoped values.
set_variable() {
  local name="$1" value="$2"
  run gh variable set "$name" --repo "$REPO" --env="$ENVIRONMENT" --body="$value"
  run gh variable set "${name}_${ENV_SUFFIX}" --repo "$REPO" --body="$value"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed (or not on PATH)"
}

check_prerequisites() {
  local active_account billing_enabled billing_account

  require_command gcloud
  require_command gh
  if [[ "$PRUNE" == true ]]; then
    # --prune reads the current IAM policies and parses them with jq.
    require_command jq
  fi

  active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
  [[ -n "$active_account" ]] || fail "gcloud has no active account; run 'gcloud auth login'"
  printf '   gcloud account: %s\n' "${active_account%%$'\n'*}"

  gh auth status >/dev/null 2>&1 || fail "gh is not logged in; run 'gh auth login'"

  gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1 ||
    fail "project ${PROJECT_ID} does not exist, or the active account cannot see it (it needs Owner); create the project and link billing first"
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

  gh repo view "$REPO" >/dev/null 2>&1 ||
    fail "cannot see the repository ${REPO} on GitHub (the account needs admin there)"

  billing_enabled="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || true)"
  if [[ "$billing_enabled" != "True" && "$billing_enabled" != "true" ]]; then
    fail "billing is not enabled on ${PROJECT_ID}, or cannot be read by this account (billingEnabled=${billing_enabled:-unreadable})"
  fi
  billing_account="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' 2>/dev/null || true)"
  printf '   billing:        %s\n' "${billing_account##*/}"
}

# ---------------------------------------------------------------------------
# Pruning (--prune, issue #161).
#
# The default run is additive. --prune additionally removes what the two managed
# service accounts of this project (deploy@ and tf-plan@, and nothing else) must
# not hold:
#   * their project-level roles that are not in the active lists at the top;
#   * their roles on the state bucket that are not declared (deploy@ is declared
#     none there);
#   * roles/iam.workloadIdentityUser members on the two accounts other than the
#     declared principalSet.
# The current policies are read with `gcloud ... get-iam-policy --format=json`
# and parsed with jq. Removals use --all, so a stale role goes whether its
# binding is conditional or not; the script itself only creates unconditional
# bindings. Only bindings whose member is one of the two accounts are ever
# considered — another member's bindings are never touched.
# ---------------------------------------------------------------------------

# Print the roles MEMBER holds in the policy JSON that are not among the allowed roles
# that follow (each role once). With no allowed roles given, every role of the member is
# stale.
stale_roles() {
  local policy_json="$1" member="$2"
  shift 2
  local role allowed keep
  while IFS= read -r role; do
    [[ -n "$role" ]] || continue
    keep=false
    for allowed in "$@"; do
      if [[ "$role" == "$allowed" ]]; then
        keep=true
        break
      fi
    done
    if [[ "$keep" == false ]]; then
      printf '%s\n' "$role"
    fi
  done < <(
    jq -r --arg member "$member" '
      (.bindings // [])[]
      | select((.members // []) | index($member))
      | .role
    ' <<<"$policy_json" | sort -u
  )
}

# remove_member_role KIND RESOURCE MEMBER ROLE — print and run the removal of one stale
# binding. KIND is 'project', 'bucket' or 'service-account'; RESOURCE is the project id,
# the gs:// URL or the service account email.
remove_member_role() {
  local kind="$1" resource="$2" member="$3" role="$4"
  printf '  remove %s from %s on %s\n' "$role" "$member" "$resource"
  case "$kind" in
    project)
      run gcloud projects remove-iam-policy-binding "$resource" \
        --member="$member" --role="$role" --all
      ;;
    bucket)
      run gcloud storage buckets remove-iam-policy-binding "$resource" \
        --member="$member" --role="$role" --all
      ;;
    service-account)
      run gcloud iam service-accounts remove-iam-policy-binding "$resource" \
        --project="$PROJECT_ID" --member="$member" --role="$role" --all
      ;;
  esac
}

# prune_member_roles KIND RESOURCE POLICY_JSON MEMBER [ROLE...] — remove every binding of
# MEMBER in the policy whose role is not among the roles.
prune_member_roles() {
  local kind="$1" resource="$2" policy_json="$3" member="$4"
  shift 4
  local role
  while IFS= read -r role; do
    [[ -n "$role" ]] || continue
    remove_member_role "$kind" "$resource" "$member" "$role"
  done < <(stale_roles "$policy_json" "$member" "$@")
}

# prune_impersonation SA_EMAIL EXPECTED — remove every roles/iam.workloadIdentityUser
# member on SA_EMAIL other than EXPECTED.
prune_impersonation() {
  local sa="$1" expected="$2" policy member
  policy="$(gcloud iam service-accounts get-iam-policy "$sa" --project="$PROJECT_ID" --format=json)"
  while IFS= read -r member; do
    [[ -n "$member" ]] || continue
    printf '  remove roles/iam.workloadIdentityUser from %s on %s\n' "$member" "$sa"
    run gcloud iam service-accounts remove-iam-policy-binding "$sa" \
      --project="$PROJECT_ID" \
      --role=roles/iam.workloadIdentityUser \
      --member="$member" \
      --all
  done < <(
    jq -r --arg expected "$expected" '
      (.bindings // [])[]
      | select(.role == "roles/iam.workloadIdentityUser")
      | (.members // [])[]
      | select(. != $expected)
    ' <<<"$policy" | sort -u
  )
}

# prune DEPLOY_PRINCIPAL_SET PLAN_PRINCIPAL_SET — the --prune pass, after the bindings
# above have been ensured.
prune() {
  local deploy_principal_set="$1" plan_principal_set="$2" policy

  if [[ "$DRY_RUN" == true ]]; then
    # The removals depend on the live policies, which only a real run reads; --dry-run
    # executes nothing, so print the rules instead of an invented list.
    section "Prune (--dry-run)"
    cat <<EOF
  --dry-run executes nothing, so the actual removals (which need the live
  policies) cannot be listed here. A real --prune run prints and removes:
    - ${SA_DEPLOY} project roles other than: ${DEPLOY_PROJECT_ROLES[*]}
    - ${SA_PLAN} project roles other than: ${PLAN_PROJECT_ROLES[*]}
    - their state-bucket roles other than PLAN_STATE_BUCKET_ROLES
      (${PLAN_STATE_BUCKET_ROLES[*]}); the deploy account is declared none
    - roles/iam.workloadIdentityUser members on the two accounts other than the
      declared principalSets.
EOF
    return 0
  fi

  section "Prune (--prune)"
  policy="$(gcloud projects get-iam-policy "$PROJECT_ID" --format=json)"
  prune_member_roles project "$PROJECT_ID" "$policy" "serviceAccount:$SA_DEPLOY" "${DEPLOY_PROJECT_ROLES[@]}"
  prune_member_roles project "$PROJECT_ID" "$policy" "serviceAccount:$SA_PLAN" "${PLAN_PROJECT_ROLES[@]}"

  policy="$(gcloud storage buckets get-iam-policy "gs://$STATE_BUCKET" --format=json)"
  prune_member_roles bucket "gs://$STATE_BUCKET" "$policy" "serviceAccount:$SA_DEPLOY"
  prune_member_roles bucket "gs://$STATE_BUCKET" "$policy" "serviceAccount:$SA_PLAN" "${PLAN_STATE_BUCKET_ROLES[@]}"

  prune_impersonation "$SA_DEPLOY" "$deploy_principal_set"
  prune_impersonation "$SA_PLAN" "$plan_principal_set"
}

main() {
  local deploy_principal_set plan_principal_set

  printf 'openharness Workload Identity setup\n'
  printf '  environment:  %s\n' "$ENVIRONMENT"
  printf '  project:      %s\n' "$PROJECT_ID"
  printf '  repo:         %s\n' "$REPO"
  printf '  region:       %s\n' "$REGION"
  printf '  deploy roles: %s\n' "$DEPLOY_ROLES_MODE"
  if [[ "$PRUNE" == true ]]; then
    printf '  prune:        yes (--prune)\n'
  fi

  if [[ "$DRY_RUN" == true ]]; then
    PROJECT_NUMBER='<project-number>'
    printf '  dry run:      yes — nothing is executed, and the project number (unknown without gcloud) is shown as <project-number>\n'
  else
    section "Prerequisites"
    check_prerequisites
  fi

  section "APIs"
  # The APIs Workload Identity and Terraform need to start (list at the top of the
  # script). Enabling an API that is already enabled is a no-op.
  run gcloud services enable "${APIS[@]}" --project="$PROJECT_ID"

  section "Workload Identity pool and GitHub OIDC provider"
  if is_missing gcloud iam workload-identity-pools describe "$POOL_ID" \
    --location="$LOCATION" --project="$PROJECT_ID"; then
    run gcloud iam workload-identity-pools create "$POOL_ID" \
      --location="$LOCATION" \
      --project="$PROJECT_ID" \
      --display-name="GitHub Actions"
  else
    # Converge a pool that exists already (#161): it is not recreated, its display name
    # is applied to whatever it is now.
    run gcloud iam workload-identity-pools update "$POOL_ID" \
      --location="$LOCATION" \
      --project="$PROJECT_ID" \
      --display-name="GitHub Actions"
  fi

  if is_missing gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --workload-identity-pool="$POOL_ID" --location="$LOCATION" --project="$PROJECT_ID"; then
    # The attribute condition is what keeps every principalSet in this pool to this repo's
    # runs: tokens from any other repository fail the exchange. The mapping exposes the
    # claims the impersonation bindings below match on.
    run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
      --workload-identity-pool="$POOL_ID" \
      --location="$LOCATION" \
      --project="$PROJECT_ID" \
      --display-name="GitHub Actions" \
      --issuer-uri="$ISSUER_URI" \
      --attribute-mapping="$ATTRIBUTE_MAPPING" \
      --attribute-condition="$ATTRIBUTE_CONDITION"
  else
    # Converge a provider that exists already (#161): the same mapping, condition and
    # issuer on every run, so a changed mapping is applied, not left at whatever the
    # provider was created with. update-oidc replaces the mapping it is given.
    run gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
      --workload-identity-pool="$POOL_ID" \
      --location="$LOCATION" \
      --project="$PROJECT_ID" \
      --display-name="GitHub Actions" \
      --issuer-uri="$ISSUER_URI" \
      --attribute-mapping="$ATTRIBUTE_MAPPING" \
      --attribute-condition="$ATTRIBUTE_CONDITION"
  fi

  section "Service accounts"
  if is_missing gcloud iam service-accounts describe "$SA_DEPLOY" --project="$PROJECT_ID"; then
    run gcloud iam service-accounts create "$SA_DEPLOY_ID" \
      --project="$PROJECT_ID" \
      --display-name="$SA_DEPLOY_DISPLAY" \
      --description="$SA_DEPLOY_DESCRIPTION"
  else
    run gcloud iam service-accounts update "$SA_DEPLOY" \
      --project="$PROJECT_ID" \
      --display-name="$SA_DEPLOY_DISPLAY" \
      --description="$SA_DEPLOY_DESCRIPTION"
  fi
  if is_missing gcloud iam service-accounts describe "$SA_PLAN" --project="$PROJECT_ID"; then
    run gcloud iam service-accounts create "$SA_PLAN_ID" \
      --project="$PROJECT_ID" \
      --display-name="$SA_PLAN_DISPLAY" \
      --description="$SA_PLAN_DESCRIPTION"
  else
    run gcloud iam service-accounts update "$SA_PLAN" \
      --project="$PROJECT_ID" \
      --display-name="$SA_PLAN_DISPLAY" \
      --description="$SA_PLAN_DESCRIPTION"
  fi

  section "Deploy account roles (${DEPLOY_ROLES_MODE})"
  # The list is DEPLOY_PROJECT_ROLES at the top: roles/owner by default, the narrower
  # alternative with --deploy-roles=narrow. gcloud's add-iam-policy-binding is
  # idempotent, so re-running re-adds what is already there without failing.
  for role in "${DEPLOY_PROJECT_ROLES[@]}"; do
    printf '  %s\n' "$role"
    run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:$SA_DEPLOY" \
      --role="$role" \
      --condition=None
  done

  section "Plan account roles"
  # Read-only: PLAN_PROJECT_ROLES at the top.
  for role in "${PLAN_PROJECT_ROLES[@]}"; do
    printf '  %s\n' "$role"
    run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:$SA_PLAN" \
      --role="$role" \
      --condition=None
  done

  section "Terraform state bucket"
  if is_missing gcloud storage buckets describe "gs://$STATE_BUCKET"; then
    run gcloud storage buckets create "gs://$STATE_BUCKET" \
      --project="$PROJECT_ID" \
      --location="$REGION" \
      --uniform-bucket-level-access \
      --public-access-prevention
  fi
  # Re-applied on every run, so a re-run also repairs settings that drifted.
  run gcloud storage buckets update "gs://$STATE_BUCKET" \
    --versioning \
    --uniform-bucket-level-access \
    --public-access-prevention
  # plan gets rights on this one bucket, not the project, so it can read the state and
  # take the lock (the create/delete of the .tflock object). The list is at the top.
  for role in "${PLAN_STATE_BUCKET_ROLES[@]}"; do
    printf '  %s\n' "$role"
    run gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" \
      --member="serviceAccount:$SA_PLAN" \
      --role="$role"
  done

  section "Impersonation bindings"
  # deploy: only a job that runs in this GitHub environment. The environment claim exists
  # only when the job declares `environment: <name>`, so no other environment, branch or PR
  # can match this member — production's deploy account is reachable only from production.
  deploy_principal_set="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.environment/$ENVIRONMENT"
  run gcloud iam service-accounts add-iam-policy-binding "$SA_DEPLOY" \
    --project="$PROJECT_ID" \
    --role=roles/iam.workloadIdentityUser \
    --member="$deploy_principal_set"

  # plan: PR runs of this repo. The provider's attribute condition already limits the pool
  # to this repository. The choice of event_name and its risk: README.md.
  plan_principal_set="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.event_name/pull_request"
  run gcloud iam service-accounts add-iam-policy-binding "$SA_PLAN" \
    --project="$PROJECT_ID" \
    --role=roles/iam.workloadIdentityUser \
    --member="$plan_principal_set"

  if [[ "$PRUNE" == true ]]; then
    prune "$deploy_principal_set" "$plan_principal_set"
  fi

  section "GitHub environment and variables"
  # The environment is only created when missing: an existing one keeps its protection
  # rules, which this script never touches.
  if is_missing gh api "repos/$REPO/environments/$ENVIRONMENT"; then
    run gh api --method PUT "repos/$REPO/environments/$ENVIRONMENT" --jq '.name'
  fi

  local wif_provider
  wif_provider="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/providers/$PROVIDER_ID"
  set_variable GCP_PROJECT_ID "$PROJECT_ID"
  set_variable GCP_PROJECT_NUMBER "$PROJECT_NUMBER"
  set_variable GCP_WIF_PROVIDER "$wif_provider"
  set_variable GCP_DEPLOY_SA "$SA_DEPLOY"
  set_variable GCP_PLAN_SA "$SA_PLAN"
  set_variable TF_STATE_BUCKET "$STATE_BUCKET"

  section "Summary"
  printf '  environment:     %s\n' "$ENVIRONMENT"
  printf '  project:         %s (%s)\n' "$PROJECT_ID" "$PROJECT_NUMBER"
  printf '  pool / provider: %s / %s (%s)\n' "$POOL_ID" "$PROVIDER_ID" "$ISSUER_URI"
  printf '  deploy account:  %s\n' "$SA_DEPLOY"
  printf '  plan account:    %s\n' "$SA_PLAN"
  printf '  state bucket:    gs://%s (versioned, uniform access, public access prevented)\n' "$STATE_BUCKET"
  printf '  GitHub:          environment %s in %s, with 6 variables + 6 repo-level *_%s variables\n' "$ENVIRONMENT" "$REPO" "$ENV_SUFFIX"
  printf '  deploy roles:    %s (%s)\n' "$DEPLOY_ROLES_MODE" "${DEPLOY_PROJECT_ROLES[*]}"
  if [[ "$PRUNE" == true ]]; then
    printf '  pruned:          yes — the managed accounts keep only the declared bindings\n'
  fi

  section "Next steps"
  if [[ "$ENVIRONMENT" == "staging" ]]; then
    OTHER_ENVIRONMENT="production"
  else
    OTHER_ENVIRONMENT="staging"
  fi
  cat <<EOF
  1. Run it for the other environment:  ./.github/setup/workload-identity.sh ${OTHER_ENVIRONMENT}
  2. A job deploying to ${ENVIRONMENT} must declare 'environment: ${ENVIRONMENT}', or its
     OIDC token carries no environment claim and impersonating ${SA_DEPLOY} fails.
  3. Terraform (wave 2, #153) reads GCP_WIF_PROVIDER, GCP_DEPLOY_SA and TF_STATE_BUCKET;
     terraform-pr.yml (#155) reads the repo-level ${ENV_SUFFIX} variables.
  4. A new OIDC provider can take a few minutes before token exchanges go through.
  5. First real deploy: the wave-5 checklist, #159.
  6. Later changes: edit the lists at the top of this script and re-run it (#161) — the
     run converges, and --prune drops bindings the lists no longer declare.
EOF
  if [[ "$DRY_RUN" == true ]]; then
    printf '\nDry run only: nothing above was executed.\n'
  fi
}

main
