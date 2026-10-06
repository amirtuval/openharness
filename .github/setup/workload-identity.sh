#!/usr/bin/env bash
#
# Workload Identity Federation setup for openharness (issue #149, epic #148, D3; #161, #167).
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
# longer declare, comparing the condition as well as the role, so a conditional binding
# whose condition changed is replaced by the re-run's grant rather than doubled.
#
# Least privilege (#167): deploy@ gets exactly the roles Terraform needs, and never
# roles/owner. Every role it holds is declared below next to the Terraform resource it
# covers, and the roles it may hand out are pinned by an IAM condition on its
# roles/resourcemanager.projectIamAdmin binding.
#
# `--dry-run` prints every gcloud and gh command without running them; that mode needs no
# gcloud, gh or login at all (only jq, which renders the conditional binding's condition
# file). It executes nothing, so it cannot list the exact bindings --prune would remove —
# reading those needs the live policies.
#
# Usage:
#   ./.github/setup/workload-identity.sh staging [--repo OWNER/REPO] [--dry-run]
#   ./.github/setup/workload-identity.sh production --prune
#
# Prerequisites, what it creates, role choices and how to undo it: README.md next to this
# script.

set -euo pipefail

# ---------------------------------------------------------------------------
# Declarative lists (issue #161). Everything this script owns is here: to add
# an API, a role or a service, edit a list and re-run — nothing else in the
# script needs touching. The binding loops below iterate these arrays.
# ---------------------------------------------------------------------------

# The two GCP projects, one per environment, created by hand before the first run
# (README.md). These are project **IDs**, not display names: every gcloud call and every
# resource name below is built from the ID, and a project's ID need not match the display
# name it is known by. Production is the case in point — its display name is
# "openharness", but its ID is openharness-510710, and only the ID works with gcloud.
# When a run cannot find the project, list the IDs with
# 'gcloud projects list --format="table(projectId,name)"'.
#
# Everything below derives from these two: the environment → project mapping, the state
# bucket (<project-id>-tfstate), the two service-account emails, the production
# cross-project binding (deploy@<production id> reading the staging project) and the
# GitHub variables.
STAGING_PROJECT_ID="openharness-dev"
PRODUCTION_PROJECT_ID="openharness-510710"

# The APIs Workload Identity and Terraform need to start. Terraform enables the rest (D4).
APIS=(
  iam.googleapis.com
  iamcredentials.googleapis.com
  sts.googleapis.com
  cloudresourcemanager.googleapis.com
  serviceusage.googleapis.com
  storage.googleapis.com
)

# Project roles for the deploy account (deploy@): the exact set Terraform (wave 2, #153)
# needs, one comment per role naming the resources it covers (#167), and never
# roles/owner. The list is expected to grow with Terraform: a role a later wave turns out
# to need is added here in that issue's PR and the maintainer re-runs this script —
# README.md, "Deploy roles: least privilege".
DEPLOY_PROJECT_ROLES=(
  roles/serviceusage.serviceUsageAdmin  # google_project_service
  roles/compute.networkAdmin            # VPC, subnet, Cloud Router/NAT, global static address
  roles/servicenetworking.networksAdmin # private services access for Cloud SQL
  roles/container.admin                 # the GKE Autopilot cluster and the helm_release objects
  roles/iam.serviceAccountAdmin         # the node and app service accounts, and their IAM policies
  roles/iam.serviceAccountUser          # acting as the node service account when the cluster is created
  roles/cloudsql.admin                  # the Cloud SQL instance, database and user
  roles/secretmanager.admin             # secrets, versions, and IAM on secrets
  roles/cloudkms.admin                  # the key ring, key, and IAM on the key (no encrypt/decrypt)
  roles/dns.admin                       # DNS zones and records, the oharness.dev import included
  roles/monitoring.editor               # uptime checks, alert policies, notification channels
  roles/browser                         # resourcemanager.projects.get for google_project data sources
  roles/logging.viewer                  # logging.logEntries.list, read by the deploy workflows' failure diagnostics (#159)
)

# Staging only (#167): the Artifact Registry (#152) lives in the staging project and
# deploy-staging.yml pushes images to it; its IAM is managed alongside it. Production
# runs hold no registry, so its list stays exactly what the repo declares.
DEPLOY_PROJECT_ROLES_STAGING=(
  roles/artifactregistry.admin
)

# The roles deploy@ may hand out — the list embedded in the IAM condition on its
# roles/resourcemanager.projectIamAdmin binding, built from this array by
# project_iam_admin_expression below. Terraform grants the node and app service accounts
# their log, metric, trace, Cloud SQL and registry-reader roles; no role here carries
# setIamPolicy permissions, and roles/resourcemanager.projectIamAdmin itself is absent on
# purpose, so the condition cannot be used to widen itself. Google Cloud IAM limits: at
# most 10 entries, string constants only, never a role with setIamPolicy permissions, and
# no joining several hasOnly() calls with && or || ("Set limits on granting roles", the
# "Delegate role granting" pattern):
# https://cloud.google.com/iam/docs/setting-limits-on-granting-roles
DEPLOY_GRANTABLE_PROJECT_ROLES=(
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

# The conditional binding's condition fields (#167). The title names the intent, and it
# is the same on every run; the expression is built from the list above.
PROJECT_IAM_ADMIN_ROLE="roles/resourcemanager.projectIamAdmin"
PROJECT_IAM_ADMIN_TITLE="terraform-grantable-roles"
PROJECT_IAM_ADMIN_DESCRIPTION="Roles deploy@ may grant or revoke (issue #167)"

# Project roles for the plan account (tf-plan@). Viewer reads most of the project;
# securityReviewer adds read-only IAM policy reads, which a plan that refreshes IAM
# resources needs; secretAccessor adds secretmanager.versions.access — reading a secret's
# payload — which neither of the others carries and which refreshing a
# google_secret_manager_secret_version needs (#153). All three are read-only: none grants
# a create, an update or a delete. The payloads it can read are the ones the plan job
# already reads out of the state bucket, where Terraform keeps them in the clear.
PLAN_PROJECT_ROLES=(
  roles/viewer
  roles/iam.securityReviewer
  roles/secretmanager.secretAccessor # refresh google_secret_manager_secret_version (#153)
)

# deploy@'s roles on the state bucket (#167): Terraform's GCS backend reads and writes
# the state and takes the lock as this account. Declared so a re-run grants it and
# --prune keeps it — before #167 the account was declared nothing here and --prune
# removed any binding it held.
DEPLOY_STATE_BUCKET_ROLES=(
  roles/storage.objectAdmin
)

# The plan account's rights on the state bucket only: read the state and take the lock
# (the create/delete of the .tflock object). --prune removes any other binding of either
# managed account there.
PLAN_STATE_BUCKET_ROLES=(
  roles/storage.objectAdmin
)

# Images are built and pushed in staging only (#152), and production promotes them by
# digest. A production run grants deploy@ of the production project reader on the staging
# project so deploy-production.yml can verify the image exists; Terraform gives the
# production GKE node account its own read access. Applied by a production run only, on
# that one project, and the single member against which a production --prune may act there.
DEPLOY_CROSS_PROJECT_ROLES=(
  roles/artifactregistry.reader
)

# Fixed names from the deployment epic (#148, D3). The two project IDs live at the top,
# with the declared lists.
POOL_ID="github"
PROVIDER_ID="github"
ISSUER_URI="https://token.actions.githubusercontent.com"
LOCATION="global" # workload identity pools and providers are always global
REGION="us-central1"

REPO="amirtuval/openharness"
ENVIRONMENT=""
DRY_RUN=false
PRUNE=false

usage() {
  cat <<EOF
Usage: workload-identity.sh <staging|production> [options]

  staging       set up project $STAGING_PROJECT_ID
  production    set up project $PRODUCTION_PROJECT_ID

Options:
  --repo OWNER/REPO    this repository (default: $REPO)
  --prune              also remove the managed accounts' bindings that are not in the
                       script's lists (project, state bucket and impersonation bindings,
                       and on a production run the cross-project grant), comparing the
                       condition as well as the role
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

case "$ENVIRONMENT" in
  staging) PROJECT_ID="$STAGING_PROJECT_ID" ;;
  production) PROJECT_ID="$PRODUCTION_PROJECT_ID" ;;
esac

# Staging carries the Artifact Registry (#167), so its deploy account also gets the
# staging-only roles; everything below — the grants, the prune and the summary — works
# from the one merged list. Production's list is exactly what the repo declares.
if [[ "$ENVIRONMENT" == "staging" ]]; then
  DEPLOY_PROJECT_ROLES+=("${DEPLOY_PROJECT_ROLES_STAGING[@]}")
fi

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

# Condition files (#167) live here for the length of the run; the trap removes them.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

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
  # jq renders the conditional binding's condition file, and --prune parses the current
  # IAM policies with it.
  require_command jq

  active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
  [[ -n "$active_account" ]] || fail "gcloud has no active account; run 'gcloud auth login'"
  printf '   gcloud account: %s\n' "${active_account%%$'\n'*}"

  gh auth status >/dev/null 2>&1 || fail "gh is not logged in; run 'gh auth login'"

  gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1 ||
    fail "project ${PROJECT_ID} does not exist, or the active account cannot see it (it needs Owner); a project's ID can differ from its display name — list the IDs this account can see with 'gcloud projects list --format=\"table(projectId,name)\"'; create the project and link billing first"
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
# The declared bindings and the condition (issues #161, #167).
#
# A binding is declared when both its role and its condition appear below: a role
# from the lists at the top is declared unconditioned, and deploy@'s
# roles/resourcemanager.projectIamAdmin is declared with exactly the condition
# built from DEPLOY_GRANTABLE_PROJECT_ROLES. Prune keeps a binding only on a full
# match, so a conditional binding whose condition changed is removed on the next
# --prune — replaced by the run's grant, never left doubled next to it.
# ---------------------------------------------------------------------------

# project_iam_admin_expression — the CEL condition that holds deploy@ to exactly
# DEPLOY_GRANTABLE_PROJECT_ROLES, built from the list so the two cannot drift apart.
project_iam_admin_expression() {
  local list="" role
  for role in "${DEPLOY_GRANTABLE_PROJECT_ROLES[@]}"; do
    if [[ -n "$list" ]]; then
      list+=", "
    fi
    list+="'${role}'"
  done
  printf "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([%s])" "$list"
}

# project_iam_admin_condition — that condition as compact JSON, the form gcloud reads
# from a file: --condition-from-file takes a JSON or YAML file with expression, title and
# description.
project_iam_admin_condition() {
  jq -c -n \
    --arg expression "$(project_iam_admin_expression)" \
    --arg title "$PROJECT_IAM_ADMIN_TITLE" \
    --arg description "$PROJECT_IAM_ADMIN_DESCRIPTION" \
    '{expression: $expression, title: $title, description: $description}'
}

# write_condition_file FILE CONDITION — put CONDITION, compact JSON, into FILE for a
# gcloud call that reads it with --condition-from-file. Conditions travel in files
# because the expression holds commas and quotes that the inline --condition=... syntax
# cannot carry reliably. A dry run writes nothing; it prints the path and content the
# real run would write, so the printed plan still shows the condition exactly as gcloud
# would receive it.
write_condition_file() {
  local file="$1" condition="$2"
  if [[ "$DRY_RUN" == true ]]; then
    printf '  (dry run: nothing written) %s would contain:\n    %s\n' "$file" "$condition"
    return 0
  fi
  printf '%s\n' "$condition" >"$file"
}

# unconditional_bindings ROLE... — the roles as a declared-bindings JSON array: one
# {role, condition: null} entry per role.
unconditional_bindings() {
  jq -c -n --args '[($ARGS.positional[]) | {role: ., condition: null}]' "$@"
}

# deploy_project_bindings — what deploy@ may hold on the project: every role of
# DEPLOY_PROJECT_ROLES unconditioned, plus the conditional project-IAM admin pair.
deploy_project_bindings() {
  local conditional
  conditional="$(jq -c -n \
    --arg role "$PROJECT_IAM_ADMIN_ROLE" \
    --argjson condition "$(project_iam_admin_condition)" \
    '[{role: $role, condition: $condition}]')"
  jq -c -n \
    --argjson roles "$(unconditional_bindings "${DEPLOY_PROJECT_ROLES[@]}")" \
    --argjson conditional "$conditional" \
    '$roles + $conditional'
}

# ---------------------------------------------------------------------------
# Pruning (--prune, issues #161 and #167).
#
# The default run is additive. --prune additionally removes what the two managed
# service accounts of this project (deploy@ and tf-plan@, and nothing else) must
# not hold:
#   * their project-level bindings that no declared pair covers, where a binding
#     counts as declared only when both its role and its condition match;
#   * their state-bucket bindings that are not declared (both accounts declare
#     roles/storage.objectAdmin there);
#   * roles/iam.workloadIdentityUser members on the two accounts other than the
#     declared principalSet.
# A production run additionally prunes the one cross-project member it manages,
# deploy@ of the production project on the staging project, against
# DEPLOY_CROSS_PROJECT_ROLES — and nothing else on that project.
# The current policies are read with `gcloud ... get-iam-policy --format=json`
# and parsed with jq. A removal carries the binding's own condition back to
# gcloud — --condition=None for an unconditional binding, --condition-from-file
# for a conditional one — so exactly the stale binding goes, never a declared one
# next to it. Only bindings whose member is one of the managed accounts are ever
# considered; another member's bindings are never touched.
# ---------------------------------------------------------------------------

# stale_bindings POLICY_JSON DECLARED_JSON MEMBER — print one line per binding of MEMBER
# that no pair in DECLARED covers: the role, a tab, and the binding's condition as
# compact JSON ('null' for an unconditional binding). Duplicate lines are collapsed.
stale_bindings() {
  local policy_json="$1" declared_json="$2" member="$3"
  jq -r --arg member "$member" --argjson declared "$declared_json" '
    (.bindings // [])[]
    | select((.members // []) | index($member))
    | select(. as $binding
        | any($declared[];
            .role == $binding.role and .condition == ($binding.condition // null))
        | not)
    | [.role, ((.condition // null) | tojson)]
    | @tsv
  ' <<<"$policy_json" | sort -u
}

# remove_member_binding KIND RESOURCE MEMBER ROLE CONDITION — print and run the removal
# of one stale binding, matching its condition exactly. KIND is 'project', 'bucket' or
# 'service-account'; RESOURCE is the project id, the gs:// URL or the service account
# email; CONDITION is 'null' for an unconditional binding or the binding's condition
# JSON.
remove_member_binding() {
  local kind="$1" resource="$2" member="$3" role="$4" condition="$5"
  local args=(--member="$member" --role="$role")
  local file
  if [[ "$condition" == "null" ]]; then
    args+=(--condition=None)
  else
    file="$WORK_DIR/remove-${role//\//-}.json"
    write_condition_file "$file" "$condition"
    args+=(--condition-from-file="$file")
  fi
  printf '  remove %s from %s on %s\n' "$role" "$member" "$resource"
  case "$kind" in
    project)
      run gcloud projects remove-iam-policy-binding "$resource" "${args[@]}"
      ;;
    bucket)
      run gcloud storage buckets remove-iam-policy-binding "$resource" "${args[@]}"
      ;;
    service-account)
      run gcloud iam service-accounts remove-iam-policy-binding "$resource" \
        --project="$PROJECT_ID" "${args[@]}"
      ;;
  esac
}

# prune_member_bindings KIND RESOURCE POLICY_JSON MEMBER DECLARED_JSON — remove every
# binding of MEMBER in the policy that no pair in DECLARED covers.
prune_member_bindings() {
  local kind="$1" resource="$2" policy_json="$3" member="$4" declared_json="$5"
  local role condition
  while IFS=$'\t' read -r role condition; do
    [[ -n "$role" ]] || continue
    remove_member_binding "$kind" "$resource" "$member" "$role" "$condition"
  done < <(stale_bindings "$policy_json" "$declared_json" "$member")
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
  policies) cannot be listed here. A real --prune run keeps only the declared
  bindings — role and condition both matching — and prints every removal:
    - ${SA_DEPLOY} project bindings other than: ${DEPLOY_PROJECT_ROLES[*]},
      and the ${PROJECT_IAM_ADMIN_ROLE} binding only while its
      condition still matches (title ${PROJECT_IAM_ADMIN_TITLE}); a binding whose
      condition changed is removed and replaced by the run's grant
    - ${SA_PLAN} project roles other than: ${PLAN_PROJECT_ROLES[*]}
    - their state-bucket roles other than the declared DEPLOY_STATE_BUCKET_ROLES
      (${DEPLOY_STATE_BUCKET_ROLES[*]}) and PLAN_STATE_BUCKET_ROLES
      (${PLAN_STATE_BUCKET_ROLES[*]})
    - roles/iam.workloadIdentityUser members on the two accounts other than the
      declared principalSets.
EOF
    if [[ "$ENVIRONMENT" == "production" ]]; then
      cat <<EOF
    - on ${STAGING_PROJECT_ID}: bindings of ${SA_DEPLOY} other than
      ${DEPLOY_CROSS_PROJECT_ROLES[*]} — the one member a production run prunes
      there, and the only thing it touches on that project.
EOF
    fi
    return 0
  fi

  section "Prune (--prune)"
  policy="$(gcloud projects get-iam-policy "$PROJECT_ID" --format=json)"
  prune_member_bindings project "$PROJECT_ID" "$policy" \
    "serviceAccount:$SA_DEPLOY" "$(deploy_project_bindings)"
  prune_member_bindings project "$PROJECT_ID" "$policy" \
    "serviceAccount:$SA_PLAN" "$(unconditional_bindings "${PLAN_PROJECT_ROLES[@]}")"

  policy="$(gcloud storage buckets get-iam-policy "gs://$STATE_BUCKET" --format=json)"
  prune_member_bindings bucket "gs://$STATE_BUCKET" "$policy" \
    "serviceAccount:$SA_DEPLOY" "$(unconditional_bindings "${DEPLOY_STATE_BUCKET_ROLES[@]}")"
  prune_member_bindings bucket "gs://$STATE_BUCKET" "$policy" \
    "serviceAccount:$SA_PLAN" "$(unconditional_bindings "${PLAN_STATE_BUCKET_ROLES[@]}")"

  prune_impersonation "$SA_DEPLOY" "$deploy_principal_set"
  prune_impersonation "$SA_PLAN" "$plan_principal_set"

  # Production's one cross-project grant (#167): prune exactly that member on the
  # staging project, and nothing else of its policy.
  if [[ "$ENVIRONMENT" == "production" ]]; then
    policy="$(gcloud projects get-iam-policy "$STAGING_PROJECT_ID" --format=json)"
    prune_member_bindings project "$STAGING_PROJECT_ID" "$policy" \
      "serviceAccount:$SA_DEPLOY" "$(unconditional_bindings "${DEPLOY_CROSS_PROJECT_ROLES[@]}")"
  fi
}

main() {
  local deploy_principal_set plan_principal_set condition_file

  printf 'openharness Workload Identity setup\n'
  printf '  environment:  %s\n' "$ENVIRONMENT"
  printf '  project:      %s\n' "$PROJECT_ID"
  printf '  repo:         %s\n' "$REPO"
  printf '  region:       %s\n' "$REGION"
  printf '  deploy roles: %d declared + 1 conditional (least privilege, no Owner)\n' \
    "${#DEPLOY_PROJECT_ROLES[@]}"
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

  section "Deploy account roles"
  # The least-privilege list at the top (#167): one entry per Terraform resource group,
  # and never roles/owner. add-iam-policy-binding is idempotent — re-adding an existing
  # binding exits 0 — so a re-run converges without failing.
  for role in "${DEPLOY_PROJECT_ROLES[@]}"; do
    printf '  %s\n' "$role"
    run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:$SA_DEPLOY" \
      --role="$role" \
      --condition=None
  done

  # The one conditional grant: project-IAM admin, held in by an IAM condition that pins
  # the roles deploy@ may hand out (DEPLOY_GRANTABLE_PROJECT_ROLES). Without the
  # condition this role could grant deploy@ Owner; with it, a request that touches any
  # other role fails the condition. The condition travels in a file because its
  # expression holds commas and quotes that the inline --condition=... syntax cannot
  # carry.
  printf '  %s (conditional: %s)\n' "$PROJECT_IAM_ADMIN_ROLE" "$PROJECT_IAM_ADMIN_TITLE"
  condition_file="$WORK_DIR/project-iam-admin-condition.json"
  write_condition_file "$condition_file" "$(project_iam_admin_condition)"
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_DEPLOY" \
    --role="$PROJECT_IAM_ADMIN_ROLE" \
    --condition-from-file="$condition_file"

  if [[ "$ENVIRONMENT" == "production" ]]; then
    section "Cross-project Artifact Registry read"
    # Images are built and pushed in staging only (#152); this grant lets
    # deploy-production.yml verify the promoted image exists. Production's GKE node
    # account gets its own read access from Terraform. A production --prune manages
    # exactly this member on this project (#167).
    for role in "${DEPLOY_CROSS_PROJECT_ROLES[@]}"; do
      printf '  %s on %s\n' "$role" "$STAGING_PROJECT_ID"
      run gcloud projects add-iam-policy-binding "$STAGING_PROJECT_ID" \
        --member="serviceAccount:$SA_DEPLOY" \
        --role="$role" \
        --condition=None
    done
  fi

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
  # Both managed accounts get rights on this one bucket, not the project: deploy reads
  # and writes the state through Terraform's GCS backend, plan reads the state and takes
  # the lock (the create/delete of the .tflock object). The lists are at the top.
  for role in "${DEPLOY_STATE_BUCKET_ROLES[@]}"; do
    printf '  %s (deploy)\n' "$role"
    run gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" \
      --member="serviceAccount:$SA_DEPLOY" \
      --role="$role" \
      --condition=None
  done
  for role in "${PLAN_STATE_BUCKET_ROLES[@]}"; do
    printf '  %s (plan)\n' "$role"
    run gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" \
      --member="serviceAccount:$SA_PLAN" \
      --role="$role" \
      --condition=None
  done

  section "Impersonation bindings"
  # deploy: only a job that runs in this GitHub environment. The environment claim exists
  # only when the job declares `environment: <name>`, so no other environment, branch or PR
  # can match this member — production's deploy account is reachable only from production.
  deploy_principal_set="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.environment/$ENVIRONMENT"
  run gcloud iam service-accounts add-iam-policy-binding "$SA_DEPLOY" \
    --project="$PROJECT_ID" \
    --role=roles/iam.workloadIdentityUser \
    --member="$deploy_principal_set" \
    --condition=None

  # plan: PR runs of this repo. The provider's attribute condition already limits the pool
  # to this repository. The choice of event_name and its risk: README.md.
  plan_principal_set="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.event_name/pull_request"
  run gcloud iam service-accounts add-iam-policy-binding "$SA_PLAN" \
    --project="$PROJECT_ID" \
    --role=roles/iam.workloadIdentityUser \
    --member="$plan_principal_set" \
    --condition=None

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
  printf '  deploy roles:    %s\n' "${DEPLOY_PROJECT_ROLES[*]}"
  printf '                   + %s (conditional: %s)\n' \
    "$PROJECT_IAM_ADMIN_ROLE" "$PROJECT_IAM_ADMIN_TITLE"
  if [[ "$ENVIRONMENT" == "production" ]]; then
    printf '  cross-project:   %s on %s\n' \
      "${DEPLOY_CROSS_PROJECT_ROLES[*]}" "$STAGING_PROJECT_ID"
  fi
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
  6. Later changes: edit the lists at the top of this script and re-run it (#161, #167) —
     the run converges, and --prune drops bindings the lists no longer declare. A role
     Terraform turns out to need goes into DEPLOY_PROJECT_ROLES; a role deploy@ must be
     able to hand out goes into DEPLOY_GRANTABLE_PROJECT_ROLES.
EOF
  if [[ "$DRY_RUN" == true ]]; then
    printf '\nDry run only: nothing above was executed.\n'
  fi
}

main
