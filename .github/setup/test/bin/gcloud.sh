#!/usr/bin/env bash
#
# Fake gcloud for the workload-identity.sh test (issue #161). This is not a gcloud: it is
# a small stateful stand-in that behaves the way workload-identity.sh uses the real CLI.
#
# State. Everything the script asks to create or bind is kept under $FAKE_STATE_DIR, so a
# second invocation sees what the first one did. Layout:
#
#   $FAKE_STATE_DIR/projects/<project-id>                     the project number
#   $FAKE_STATE_DIR/apis/<project-id>/<api>                   enabled API (marker)
#   $FAKE_STATE_DIR/pools/<project-id>/<pool-id>              pool display name
#   $FAKE_STATE_DIR/providers/<project-id>/<pool>/<p>.json    provider fields (JSON)
#   $FAKE_STATE_DIR/service-accounts/<project-id>/<email>.json  displayName, description
#   $FAKE_STATE_DIR/buckets/<bucket-name>.json                bucket settings (JSON)
#   $FAKE_STATE_DIR/policies/project-<project-id>.json        project IAM policy
#   $FAKE_STATE_DIR/policies/bucket-<bucket-name>.json        bucket IAM policy
#   $FAKE_STATE_DIR/policies/sa-<email>.json                  service-account IAM policy
#   $FAKE_STATE_DIR/calls.log                                 one line per invocation
#
# The test seeds only the two hand-made projects (README: projects exist already); every
# other path is created by the script, through this fake.
#
# Behaviour kept faithful to the real CLI, because the test checks for it:
#   * create/create-oidc fail with a non-zero exit and an ALREADY_EXISTS message when the
#     resource exists (not_found otherwise, for describe/update);
#   * add-iam-policy-binding is idempotent — re-adding an existing binding exits 0 (the
#     setup script relies on that for its re-run safety);
#   * services enable is a no-op for an API that is already enabled;
#   * IAM conditions are not modelled: bindings are (role, member) pairs, and removal
#     takes the whole (role, member) pair, which is what `remove ... --all` does.
#
# Every invocation is appended to calls.log as one line: 'gcloud' followed by the
# arguments, space-separated (raw, so the test can grep for them).

set -euo pipefail

STATE="${FAKE_STATE_DIR:?fake gcloud: set FAKE_STATE_DIR}"
mkdir -p "$STATE"
args=("$@")

{
  printf 'gcloud'
  for a in "${args[@]+"${args[@]}"}"; do printf ' %s' "$a"; done
  printf '\n'
} >>"$STATE/calls.log"

cmdline() { printf '%s' "${args[*]:-}"; }
not_found() { printf 'ERROR: NOT_FOUND: %s\n' "$*" >&2; exit 1; }
already_exists() { printf 'ERROR: ALREADY_EXISTS: %s\n' "$*" >&2; exit 1; }
unhandled() { printf 'ERROR: (fake gcloud) unhandled invocation: %s\n' "$(cmdline)" >&2; exit 127; }

# flag NAME [DEFAULT] — the value of the --NAME=VALUE argument, or DEFAULT.
flag() {
  local name="$1" default="${2-}" a
  for a in "${args[@]+"${args[@]}"}"; do
    case "$a" in
      --"$name"=*) printf '%s' "${a#--"$name"=}"; return 0 ;;
    esac
  done
  printf '%s' "$default"
}

# has_flag NAME — true when the exact argument --NAME is present.
has_flag() {
  local name="$1" a
  for a in "${args[@]+"${args[@]}"}"; do
    case "$a" in --"$name") return 0 ;; esac
  done
  return 1
}

# last_positional — the last argument that is not a flag. Every call this fake sees
# passes flag values as --flag=value, so this is the resource.
last_positional() {
  local a last=""
  for a in "${args[@]+"${args[@]}"}"; do
    case "$a" in --*) ;; *) last="$a" ;; esac
  done
  printf '%s' "$last"
}

require_project() {
  [[ -f "$STATE/projects/$1" ]] || not_found "project [$1]"
}

policy_path() { printf '%s/policies/%s.json' "$STATE" "$1"; }

# policy_print FILE — the policy, or an empty one when nothing has been written yet.
policy_print() {
  if [[ -f "$1" ]]; then
    cat "$1"
  else
    printf '{"bindings": [], "etag": "fake-etag"}\n'
  fi
}

policy_init() {
  mkdir -p "$(dirname "$1")"
  [[ -f "$1" ]] || printf '{"bindings": [], "etag": "fake-etag"}\n' >"$1"
}

# binding_has FILE MEMBER ROLE
binding_has() {
  jq -e --arg member "$2" --arg role "$3" \
    'any((.bindings // [])[]; .role == $role and ((.members // []) | index($member)))' \
    "$1" >/dev/null 2>&1
}

# binding_add FILE MEMBER ROLE — idempotent, like the real add-iam-policy-binding.
binding_add() {
  local file="$1" member="$2" role="$3" tmp
  policy_init "$file"
  if binding_has "$file" "$member" "$role"; then
    printf 'No changes to the policy.\n'
    return 0
  fi
  tmp="$(mktemp)"
  jq --arg member "$member" --arg role "$role" \
    '.bindings = ((.bindings // []) + [{"role": $role, "members": [$member]}])' \
    "$file" >"$tmp"
  mv "$tmp" "$file"
  printf 'Updated IAM policy.\n'
}

# binding_remove FILE MEMBER ROLE — removes the member from every binding of the role
# (what the real CLI's --all does); fails when the binding is not there.
binding_remove() {
  local file="$1" member="$2" role="$3" tmp
  if ! binding_has "$file" "$member" "$role"; then
    not_found "binding [$role] for [$member]"
  fi
  tmp="$(mktemp)"
  jq --arg member "$member" --arg role "$role" '
    .bindings = [(.bindings // [])[]
      | if .role == $role then .members = [.members[] | select(. != $member)] else . end
      | select((.members // []) | length > 0)]
  ' "$file" >"$tmp"
  mv "$tmp" "$file"
  printf 'Updated IAM policy.\n'
}

auth() {
  if [[ "${args[1]:-}" == "list" ]]; then
    printf 'maintainer@example.com\n'
    return 0
  fi
  unhandled
}

projects() {
  local verb="${args[1]:-}" project format number file
  project="$(last_positional)"
  case "$verb" in
    describe)
      require_project "$project"
      number="$(cat "$STATE/projects/$project")"
      format="$(flag format)"
      case "$format" in
        'value(projectNumber)') printf '%s\n' "$number" ;;
        'value(billingEnabled)') printf 'True\n' ;;
        'value(billingAccountName)') printf 'billingAccounts/01A2B3-C4D5E6-F7G8H9\n' ;;
        '') printf 'projectId: %s\nprojectNumber: %s\n' "$project" "$number" ;;
        *) unhandled ;;
      esac
      ;;
    get-iam-policy)
      require_project "$project"
      policy_print "$(policy_path "project-$project")"
      ;;
    add-iam-policy-binding)
      require_project "$project"
      file="$(policy_path "project-$project")"
      binding_add "$file" "$(flag member)" "$(flag role)"
      ;;
    remove-iam-policy-binding)
      require_project "$project"
      file="$(policy_path "project-$project")"
      binding_remove "$file" "$(flag member)" "$(flag role)"
      ;;
    *) unhandled ;;
  esac
}

billing() {
  local project format
  project="$(last_positional)"
  if [[ "${args[1]:-}" != "projects" || "${args[2]:-}" != "describe" ]]; then
    unhandled
  fi
  require_project "$project"
  format="$(flag format)"
  case "$format" in
    'value(billingEnabled)') printf 'True\n' ;;
    'value(billingAccountName)') printf 'billingAccounts/01A2B3-C4D5E6-F7G8H9\n' ;;
    *) printf 'billingEnabled: True\nbillingAccountName: billingAccounts/01A2B3-C4D5E6-F7G8H9\n' ;;
  esac
}

services() {
  local project api
  if [[ "${args[1]:-}" != "enable" ]]; then
    unhandled
  fi
  project="$(flag project)"
  require_project "$project"
  for api in "${args[@]:2}"; do
    case "$api" in --*) break ;; esac
    mkdir -p "$STATE/apis/$project"
    : >"$STATE/apis/$project/$api"
  done
  printf 'Operation "operations/fake" finished successfully.\n'
}

wif_pools() {
  case "${args[2]:-}" in
    providers) wif_providers ;;
    describe | create | update) wif_pool_resource "${args[2]}" ;;
    *) unhandled ;;
  esac
}

wif_pool_resource() {
  local verb="$1" project pool file
  project="$(flag project)"
  pool="$(last_positional)"
  require_project "$project"
  file="$STATE/pools/$project/$pool"
  case "$verb" in
    describe)
      [[ -f "$file" ]] || not_found "workload identity pool [$pool] in [$project]"
      printf 'displayName: %s\nname: projects/%s/locations/global/workloadIdentityPools/%s\n' \
        "$(cat "$file")" "$project" "$pool"
      ;;
    create)
      if [[ -f "$file" ]]; then already_exists "workload identity pool [$pool] in [$project]"; fi
      mkdir -p "$(dirname "$file")"
      printf '%s\n' "$(flag display-name)" >"$file"
      printf 'Created workload identity pool [%s].\n' "$pool"
      ;;
    update)
      [[ -f "$file" ]] || not_found "workload identity pool [$pool] in [$project]"
      printf '%s\n' "$(flag display-name)" >"$file"
      printf 'Updated workload identity pool [%s].\n' "$pool"
      ;;
  esac
}

wif_providers() {
  local verb="${args[3]:-}" project pool provider file
  project="$(flag project)"
  pool="$(flag workload-identity-pool)"
  provider="$(last_positional)"
  require_project "$project"
  file="$STATE/providers/$project/$pool/$provider.json"
  case "$verb" in
    describe)
      [[ -f "$file" ]] || not_found "provider [$provider] in pool [$pool]"
      cat "$file"
      ;;
    create-oidc)
      if [[ -f "$file" ]]; then already_exists "provider [$provider] in pool [$pool]"; fi
      mkdir -p "$(dirname "$file")"
      write_provider "$file"
      printf 'Created provider [%s].\n' "$provider"
      ;;
    update-oidc)
      [[ -f "$file" ]] || not_found "provider [$provider] in pool [$pool]"
      write_provider "$file"
      printf 'Updated provider [%s].\n' "$provider"
      ;;
    *) unhandled ;;
  esac
}

# write_provider FILE — store the provider fields from the create/update flags.
write_provider() {
  jq -n \
    --arg displayName "$(flag display-name)" \
    --arg issuerUri "$(flag issuer-uri)" \
    --arg attributeMapping "$(flag attribute-mapping)" \
    --arg attributeCondition "$(flag attribute-condition)" \
    '{displayName: $displayName, issuerUri: $issuerUri, attributeMapping: $attributeMapping, attributeCondition: $attributeCondition}' \
    >"$1"
}

# sa_email NAME_OR_EMAIL PROJECT — the full email everything is keyed by.
sa_email() {
  local name="$1" project="$2"
  case "$name" in
    *@*) printf '%s' "$name" ;;
    *) printf '%s@%s.iam.gserviceaccount.com' "$name" "$project" ;;
  esac
}

service_accounts() {
  case "${args[2]:-}" in
    describe | create | update) service_account_resource "${args[2]}" ;;
    add-iam-policy-binding | remove-iam-policy-binding | get-iam-policy) service_account_policy "${args[2]}" ;;
    *) unhandled ;;
  esac
}

service_account_resource() {
  local verb="$1" project email file
  project="$(flag project)"
  email="$(sa_email "$(last_positional)" "$project")"
  require_project "$project"
  file="$STATE/service-accounts/$project/$email.json"
  case "$verb" in
    describe)
      [[ -f "$file" ]] || not_found "service account [$email]"
      cat "$file"
      ;;
    create)
      if [[ -f "$file" ]]; then already_exists "service account [$email]"; fi
      mkdir -p "$(dirname "$file")"
      write_sa "$file"
      printf 'Created service account [%s].\n' "$email"
      ;;
    update)
      [[ -f "$file" ]] || not_found "service account [$email]"
      write_sa "$file"
      printf 'Updated service account [%s].\n' "$email"
      ;;
  esac
}

# write_sa FILE — store displayName and description from the flags.
write_sa() {
  jq -n \
    --arg displayName "$(flag display-name)" \
    --arg description "$(flag description)" \
    '{displayName: $displayName, description: $description}' \
    >"$1"
}

service_account_policy() {
  local verb="$1" project email file
  project="$(flag project)"
  email="$(sa_email "$(last_positional)" "$project")"
  require_project "$project"
  [[ -f "$STATE/service-accounts/$project/$email.json" ]] || not_found "service account [$email]"
  file="$(policy_path "sa-$email")"
  case "$verb" in
    get-iam-policy) policy_print "$file" ;;
    add-iam-policy-binding) binding_add "$file" "$(flag member)" "$(flag role)" ;;
    remove-iam-policy-binding) binding_remove "$file" "$(flag member)" "$(flag role)" ;;
  esac
}

# bucket_name — the positional gs:// URL, without its scheme.
bucket_name() {
  local url
  url="$(last_positional)"
  printf '%s' "${url#gs://}"
}

storage() {
  if [[ "${args[1]:-}" != "buckets" ]]; then
    unhandled
  fi
  case "${args[2]:-}" in
    describe) bucket_describe ;;
    create) bucket_create ;;
    update) bucket_update ;;
    add-iam-policy-binding | remove-iam-policy-binding | get-iam-policy) bucket_policy "${args[2]}" ;;
    *) unhandled ;;
  esac
}

bucket_describe() {
  local name
  name="$(bucket_name)"
  [[ -f "$STATE/buckets/$name.json" ]] || not_found "bucket [gs://$name]"
  cat "$STATE/buckets/$name.json"
}

bucket_create() {
  local name
  name="$(bucket_name)"
  require_project "$(flag project)"
  if [[ -f "$STATE/buckets/$name.json" ]]; then already_exists "bucket [gs://$name]"; fi
  mkdir -p "$STATE/buckets"
  jq -n --arg location "$(flag location)" \
    '{location: $location, versioning: false, uniformBucketLevelAccess: false, publicAccessPrevention: false}' \
    >"$STATE/buckets/$name.json"
  printf 'Creating gs://%s/ without any additional configuration...\n' "$name"
}

bucket_update() {
  local name versioning=false ubla=false pap=false tmp
  name="$(bucket_name)"
  [[ -f "$STATE/buckets/$name.json" ]] || not_found "bucket [gs://$name]"
  if has_flag versioning; then versioning=true; fi
  if has_flag uniform-bucket-level-access; then ubla=true; fi
  if has_flag public-access-prevention; then pap=true; fi
  tmp="$(mktemp)"
  jq --argjson v "$versioning" --argjson u "$ubla" --argjson p "$pap" '
    (if $v then .versioning = true else . end)
    | (if $u then .uniformBucketLevelAccess = true else . end)
    | (if $p then .publicAccessPrevention = true else . end)
  ' "$STATE/buckets/$name.json" >"$tmp"
  mv "$tmp" "$STATE/buckets/$name.json"
  printf 'Updated gs://%s/.\n' "$name"
}

bucket_policy() {
  local verb="$1" name file
  name="$(bucket_name)"
  [[ -f "$STATE/buckets/$name.json" ]] || not_found "bucket [gs://$name]"
  file="$(policy_path "bucket-$name")"
  case "$verb" in
    get-iam-policy) policy_print "$file" ;;
    add-iam-policy-binding) binding_add "$file" "$(flag member)" "$(flag role)" ;;
    remove-iam-policy-binding) binding_remove "$file" "$(flag member)" "$(flag role)" ;;
  esac
}

case "${args[0]:-}" in
  auth) auth ;;
  billing) billing ;;
  projects) projects ;;
  services) services ;;
  iam)
    case "${args[1]:-}" in
      workload-identity-pools) wif_pools ;;
      service-accounts) service_accounts ;;
      *) unhandled ;;
    esac
    ;;
  storage) storage ;;
  *) unhandled ;;
esac
