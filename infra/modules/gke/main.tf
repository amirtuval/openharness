# GKE Autopilot cluster with Workload Identity and the Secret Manager add-on
# enabled (issue #153, epic #148 D4/D5).

# A custom, least-privilege node service account per cluster, rather than the
# Compute Engine default account. Its email is predictable
# (<id>@<project>.iam.gserviceaccount.com), which is how staging takes
# production's account by name to grant it registry read.
resource "google_service_account" "nodes" {
  project      = var.project_id
  account_id   = var.node_service_account_id
  display_name = "openharness GKE nodes (${var.name})"
  description  = "Node service account for the ${var.name} GKE cluster."
}

resource "google_project_iam_member" "nodes_default_service_account" {
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_container_cluster" "cluster" {
  project     = var.project_id
  name        = var.name
  location    = var.region
  description = "openharness ${var.name} Autopilot cluster"

  enable_autopilot = true
  networking_mode  = "VPC_NATIVE"

  network    = var.network_id
  subnetwork = var.subnetwork_id

  ip_allocation_policy {
    cluster_secondary_range_name  = var.pods_range_name
    services_secondary_range_name = var.services_range_name
  }

  release_channel {
    channel = var.release_channel
  }

  # Workload Identity: the Kubernetes service account
  # <namespace>/<release> maps to the app GCP service account.
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # The GKE Secret Manager add-on; the chart mounts the secrets through the
  # SecretProviderClass it creates (epic #148 D5).
  secret_manager_config {
    enabled = true
  }

  # Private nodes, public control plane: the nodes have no addresses of their
  # own and reach the internet through Cloud NAT, while Terraform in CI reaches
  # the API server over its public endpoint.
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = var.master_ipv4_cidr_block
  }

  deletion_protection = var.deletion_protection

  # Autopilot ignores node_config.service_account, so the custom node service
  # account is set through the autoscaling defaults instead. It can only be set
  # when the cluster is created — changing it replaces the cluster.
  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }

  resource_labels = {
    environment = var.name
    managed-by  = "terraform"
  }
}
