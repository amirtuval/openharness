#!/usr/bin/env bash
#
# One-time Workload Identity Federation setup for openharness (issue #149, epic #148, D3).
#
# The maintainer runs this once per GCP project, with their own gcloud credentials, before
# the first Terraform apply. GitHub Actions cannot create its own Workload Identity — the
# identity it would use to create it does not exist yet — so this is the one piece of the
# deployment that is not Terraform.
#
# Safe to run again: it creates what is missing, re-applies the settings it owns, and
# touches nothing else. `--dry-run` prints every gcloud and gh command without running
# them; that mode needs no gcloud, gh or login at all.
#
# Usage:
#   ./.github/setup/workload-identity.sh staging [--repo OWNER/REPO] [--dry-run]
#   ./.github/setup/workload-identity.sh production
#
# Prerequisites, what it creates, role choices and how to undo it: README.md next to this
# script.

set -euo pipefail

# Fixed names from the deployment epic (#148, D3).
POOL_ID="github"
PROVIDER_ID="github"
ISSUER_URI="https://token.actions.githubusercontent.com"
LOCATION="global" # workload identity pools and providers are always global
REGION="us-central1"

REPO="amirtuval/openharness"
ENVIRONMENT=""
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: workload-identity.sh <staging|production> [options]

  staging       set up project openharness-dev
  production    set up project openharness

Options:
  --repo OWNER/REPO   this repository (default: amirtuval/openharness)
  --dry-run           print every gcloud and gh command without running it
  -h, --help          show this help and exit

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

case "$ENVIRONMENT" in
  staging) PROJECT_ID="openharness-dev" ;;
  production) PROJECT_ID="openharness" ;;
esac

SA_DEPLOY="deploy@${PROJECT_ID}.iam.gserviceaccount.com"
SA_PLAN="plan@${PROJECT_ID}.iam.gserviceaccount.com"
STATE_BUCKET="${PROJECT_ID}-tfstate"
ENV_SUFFIX="$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')"

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

main() {
  printf 'openharness Workload Identity setup\n'
  printf '  environment: %s\n' "$ENVIRONMENT"
  printf '  project:     %s\n' "$PROJECT_ID"
  printf '  repo:        %s\n' "$REPO"
  printf '  region:      %s\n' "$REGION"

  if [[ "$DRY_RUN" == true ]]; then
    PROJECT_NUMBER='<project-number>'
    printf '  dry run:     yes — nothing is executed, and the project number (unknown without gcloud) is shown as <project-number>\n'
  else
    section "Prerequisites"
    check_prerequisites
  fi

  section "APIs"
  # The APIs Workload Identity and Terraform need to start. Terraform enables the rest (D4).
  run gcloud services enable \
    iam.googleapis.com \
    iamcredentials.googleapis.com \
    sts.googleapis.com \
    cloudresourcemanager.googleapis.com \
    serviceusage.googleapis.com \
    storage.googleapis.com \
    --project="$PROJECT_ID"

  section "Workload Identity pool and GitHub OIDC provider"
  if is_missing gcloud iam workload-identity-pools describe "$POOL_ID" \
    --location="$LOCATION" --project="$PROJECT_ID"; then
    run gcloud iam workload-identity-pools create "$POOL_ID" \
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
      --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name" \
      --attribute-condition="assertion.repository == '$REPO'"
  fi

  section "Service accounts"
  if is_missing gcloud iam service-accounts describe "$SA_DEPLOY" --project="$PROJECT_ID"; then
    run gcloud iam service-accounts create deploy \
      --project="$PROJECT_ID" \
      --display-name="Terraform deploy (GitHub Actions)" \
      --description="Terraform apply for ${ENVIRONMENT} (epic #148, D3)"
  fi
  if is_missing gcloud iam service-accounts describe "$SA_PLAN" --project="$PROJECT_ID"; then
    run gcloud iam service-accounts create plan \
      --project="$PROJECT_ID" \
      --display-name="Terraform plan (GitHub Actions PRs)" \
      --description="Read-only terraform plan for PRs (epic #148, D3)"
  fi

  section "Deploy account roles"
  # Terraform manages the whole project, so the deploy account is given roles/owner.
  # The rationale and the risk are in README.md ("Role choices and risk").
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_DEPLOY" \
    --role=roles/owner \
    --condition=None

  # Alternative to Owner: uncomment this loop and drop the roles/owner binding above,
  # keeping it in sync as Terraform grows. Even then, the billing budgets (D4) live on the
  # billing account and need a grant there — project-level Owner does not cover them either.
  # for role in \
  #   roles/serviceusage.serviceUsageAdmin \
  #   roles/iam.serviceAccountAdmin \
  #   roles/resourcemanager.projectIamAdmin \
  #   roles/storage.admin \
  #   roles/artifactregistry.admin \
  #   roles/compute.admin \
  #   roles/container.admin \
  #   roles/cloudsql.admin \
  #   roles/secretmanager.admin \
  #   roles/cloudkms.admin \
  #   roles/dns.admin \
  #   roles/monitoring.admin \
  #   roles/logging.admin; do
  #   run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  #     --member="serviceAccount:$SA_DEPLOY" \
  #     --role="$role" \
  #     --condition=None
  # done

  section "Plan account roles"
  # Viewer reads most of the project; securityReviewer adds read-only IAM policy reads,
  # which a plan that refreshes IAM resources needs. Both are read-only.
  for role in roles/viewer roles/iam.securityReviewer; do
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
  # take the lock (the create/delete of the .tflock object).
  run gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" \
    --member="serviceAccount:$SA_PLAN" \
    --role=roles/storage.objectAdmin

  section "Impersonation bindings"
  # deploy: only a job that runs in this GitHub environment. The environment claim exists
  # only when the job declares `environment: <name>`, so no other environment, branch or PR
  # can match this member — production's deploy account is reachable only from production.
  run gcloud iam service-accounts add-iam-policy-binding "$SA_DEPLOY" \
    --project="$PROJECT_ID" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.environment/$ENVIRONMENT"

  # plan: PR runs of this repo. The provider's attribute condition already limits the pool
  # to this repository. The choice of event_name and its risk: README.md.
  run gcloud iam service-accounts add-iam-policy-binding "$SA_PLAN" \
    --project="$PROJECT_ID" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.event_name/pull_request"

  section "GitHub environment and variables"
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
EOF
  if [[ "$DRY_RUN" == true ]]; then
    printf '\nDry run only: nothing above was executed.\n'
  fi
}

main
