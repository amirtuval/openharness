# VPC, subnet, private services access for Cloud SQL, and Cloud NAT for egress
# (issue #153, epic #148 D4). Autopilot nodes have no external IPs, so without
# NAT they could not pull images from Artifact Registry or reach the internet.

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = var.name
  auto_create_subnetworks = false
  routing_mode            = "GLOBAL"
  description             = "openharness ${var.name} VPC"
}

resource "google_compute_subnetwork" "subnet" {
  project                  = var.project_id
  name                     = var.name
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
  description              = "openharness ${var.name} nodes, pods and services"

  # Autopilot with a custom VPC needs explicit secondary ranges: it will not
  # carve them out of the subnet itself.
  secondary_ip_range {
    range_name    = var.pods_range_name
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = var.services_range_name
    ip_cidr_range = var.services_cidr
  }
}

# The range Cloud SQL's private IP is drawn from. Private services access peers
# this range with Google's own VPC, which is what makes a private-only instance
# reachable from the cluster.
resource "google_compute_global_address" "private_services" {
  project       = var.project_id
  name          = "${var.name}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_services_prefix_length
  network       = google_compute_network.vpc.id
  description   = "private services access for Cloud SQL"
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

# Egress for the nodes: they have no external addresses of their own.
resource "google_compute_router" "router" {
  project = var.project_id
  name    = "${var.name}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  project                            = var.project_id
  name                               = "${var.name}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
