# The application: a reserved global static IP, the app identity's Workload
# Identity binding and its project roles, and the helm_release of the chart
# (issue #153, epic #148 D1/D2/D4).

# The address the Ingress claims by name
# (kubernetes.io/ingress.global-static-ip-name). Reserved here, so the chart
# never races the load balancer for an ephemeral address.
resource "google_compute_global_address" "static_ip" {
  project      = var.project_id
  name         = local.static_ip_name
  address_type = "EXTERNAL"
  description  = "openharness ${var.release_name} ingress address"
}

# Workload Identity: the Kubernetes service account the chart creates may
# impersonate the app GCP service account.
resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.app_service_account_email}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.namespace}/${var.kubernetes_service_account}]"
}

# The app's project-level roles — traces, logs, metrics and connecting the Cloud
# SQL Auth Proxy sidecar (#159), and nothing more. All of them are in the setup
# script's DEPLOY_GRANTABLE_PROJECT_ROLES, which is what deploy@ may hand out at
# project level.
resource "google_project_iam_member" "app" {
  for_each = toset(var.project_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${var.app_service_account_email}"
}

resource "helm_release" "app" {
  name             = var.release_name
  namespace        = var.namespace
  create_namespace = true
  chart            = local.chart_path
  timeout          = var.helm_timeout

  # Self-cleaning release (#159). Without these two a rollout that never becomes
  # ready leaves a *failed* Helm release in the cluster while Terraform records
  # nothing, because a failed apply writes no state — and every retry then dies
  # with "cannot re-use a name that is still in use" until someone uninstalls the
  # release by hand. That is exactly how the first staging deploy (wave 5, #159)
  # ended.
  #
  #   atomic          a failed *install* is uninstalled and a failed *upgrade* is
  #                   rolled back to the last good revision. It also sets `wait`,
  #                   so the release is not reported created until the pods are
  #                   ready (and `timeout` below is how long that is allowed to
  #                   take).
  #   cleanup_on_fail delete the resources the failed attempt created, so the
  #                   rollback leaves no half-applied objects behind.
  #
  # Both are top-level boolean arguments in the pinned provider (hashicorp/helm
  # 3.3.0 — infra/envs/*/.terraform.lock.hcl), not blocks; v2 spells them the same
  # way, so there is no syntax change to make here.
  atomic          = true
  cleanup_on_fail = true

  # env and secrets go in as one YAML document, not as `set` entries: `secrets`
  # is a list of objects, which `set` cannot express.
  values = [yamlencode(local.values)]
}
