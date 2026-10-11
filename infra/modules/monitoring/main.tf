# Monitoring: an uptime check, and the alerts that say when something is wrong
# (issue #158, epic #148). GCP's own Monitoring — no third-party agent, and inside
# the free tier at this scale (see docs/DEPLOYMENT.md).
#
# The email notification channel is the switch: `alert_email` empty (the default)
# creates neither a channel nor an alert policy, so the first apply of an
# environment succeeds before anyone has decided who gets paged. The uptime check
# itself is created either way — it is what the console's own uptime dashboard
# reads — and the alert on it, like every other alert here, waits for an address.
#
# Every metric name, resource type and label below is the GCP Monitoring one; the
# thresholds are variables with defaults that fit this deployment's size.

locals {
  # Alerts exist only once there is somewhere to send them.
  enabled = var.alert_email != ""

  # The one channel every alert policy notifies. Empty while `enabled` is false,
  # which is the empty list `notification_channels` takes.
  channels = local.enabled ? [google_monitoring_notification_channel.email[0].name] : []

  # The Cloud SQL instances and GKE containers this project runs. Both metrics are
  # project-wide, and at this size that is exactly the deployment's one instance
  # and its one container.
  cloudsql_filter  = "resource.type=\"cloudsql_database\" AND resource.label.project_id=\"${var.project_id}\""
  container_filter = "resource.type=\"k8s_container\" AND resource.label.project_id=\"${var.project_id}\""

  # The restart policy watches the app's namespace only. GKE's own system
  # DaemonSets (`kube-system`, `gke-gmp-system`) restart once on every Autopilot
  # node replacement — their logs show the apiserver unreachable while the node's
  # network is not up yet — and that churn is normal, so paging on it is noise.
  # The app crash loops this alert exists for run in `var.app_namespace` (#325).
  container_restarts_filter = "${local.container_filter} AND resource.label.namespace_name=\"${var.app_namespace}\""
}

# --- the channel the alerts go to -------------------------------------------------

resource "google_monitoring_notification_channel" "email" {
  count = local.enabled ? 1 : 0

  project      = var.project_id
  display_name = "${var.name_prefix} alerts (${var.host})"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }
}

# --- the uptime check -------------------------------------------------------------

# `GET https://<host>/health` every five minutes, from Google's own probes: the
# liveness endpoint (#151), which answers 200 while the process is alive and does
# not touch the database — so a red check means the deployment is unreachable, not
# that Cloud SQL is slow.
resource "google_monitoring_uptime_check_config" "health" {
  project      = var.project_id
  display_name = "${var.name_prefix} ${var.host}${var.uptime_check_path}"

  timeout = var.uptime_check_timeout
  period  = var.uptime_check_period

  http_check {
    path         = var.uptime_check_path
    port         = 443
    use_ssl      = true
    validate_ssl = true

    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.host
    }
  }

  # Three regions: one probe region failing is a probe problem, three is a
  # deployment problem, and the check's own alert reads the per-region results.
  selected_regions = ["USA", "EUROPE", "ASIA_PACIFIC"]
}

# --- the alerts -------------------------------------------------------------------

# The uptime check failing from every region for five minutes.
resource "google_monitoring_alert_policy" "uptime" {
  count = local.enabled ? 1 : 0

  project               = var.project_id
  display_name          = "${var.name_prefix} ${var.host} is down"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "uptime check fails from every region"

    condition_threshold {
      # `check_passed` is 0 when the probe failed and 1 when it succeeded;
      # REDUCE_COUNT_FALSE counts the zeroes, so a threshold above zero means "some
      # region failed" rather than "the average was low".
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.health.uptime_check_id}\" AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The uptime check on https://${var.host}${var.uptime_check_path} is failing. Check the load balancer's backend health and the GKE deployment's pods; `kubectl -n openharness get pods` and the deployment's rollout status are the first two things to look at."
  }
}

# A high 5xx rate on the load balancer: the origin is answering errors.
resource "google_monitoring_alert_policy" "http_5xx" {
  count = local.enabled ? 1 : 0

  project               = var.project_id
  display_name          = "${var.name_prefix} ${var.host} is returning 5xx"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "load balancer 5xx rate"

    condition_threshold {
      filter          = "metric.type=\"loadbalancing.googleapis.com/https/request_count\" AND metric.label.response_code_class=\"500\" AND resource.type=\"https_lb_rule\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.http_5xx_threshold
      duration        = "300s"

      aggregations {
        alignment_period = "300s"
        # Per-series rate, then summed across the backend's series: the deployment's
        # own 5xx responses per second, whatever the load balancer's series turn out
        # to be.
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.forwarding_rule_name"]
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "More than ${var.http_5xx_threshold} 5xx responses per second from the load balancer. The server logs the failing requests as JSON with their path and status (issue #158); read them in Cloud Logging, joined to the request's trace, before reaching for the pods."
  }
}

# Cloud SQL CPU saturated: turns get slow before they fail.
resource "google_monitoring_alert_policy" "cloudsql_cpu" {
  count = local.enabled ? 1 : 0

  project               = var.project_id
  display_name          = "${var.name_prefix} Cloud SQL CPU above ${var.db_cpu_threshold * 100}%"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "Cloud SQL CPU utilization"

    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND ${local.cloudsql_filter}"
      comparison      = "COMPARISON_GT"
      threshold_value = var.db_cpu_threshold
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MEAN"
        group_by_fields      = ["resource.label.database_id"]
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Cloud SQL CPU stayed above ${var.db_cpu_threshold * 100}% of its capacity for five minutes. A shared-core tier in staging is the usual cause; in production the query behind a busy turn is. `gcloud sql instances describe` and Cloud SQL's own query insights are the place to look."
  }
}

# Cloud SQL disk filling: a full disk stops writes, migrations included.
resource "google_monitoring_alert_policy" "cloudsql_disk" {
  count = local.enabled ? 1 : 0

  project               = var.project_id
  display_name          = "${var.name_prefix} Cloud SQL disk above ${var.db_disk_threshold * 100}%"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "Cloud SQL disk utilization"

    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND ${local.cloudsql_filter}"
      comparison      = "COMPARISON_GT"
      threshold_value = var.db_disk_threshold
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MEAN"
        group_by_fields      = ["resource.label.database_id"]
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Cloud SQL disk usage stayed above ${var.db_disk_threshold * 100}%. Cloud SQL grows the disk on its own unless it is at its limit; check the instance's storage size, and whether the session log's compaction job is running (it deletes superseded stream chunks; `OPENHARNESS_COMPACT_INTERVAL_MS`)."
  }
}

# Containers restarting in the app's namespace: a crash loop, or a health probe
# the deployment cannot pass. Deliberately not project-wide: GKE's system
# DaemonSets restart once on every Autopilot node replacement, and paging on that
# is noise (issue #325).
resource "google_monitoring_alert_policy" "container_restarts" {
  count = local.enabled ? 1 : 0

  project               = var.project_id
  display_name          = "${var.name_prefix} containers restarting"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "container restarts"

    condition_threshold {
      filter          = "metric.type=\"kubernetes.io/container/restart_count\" AND ${local.container_restarts_filter}"
      comparison      = "COMPARISON_GT"
      threshold_value = var.container_restart_threshold
      # Any increase over the hour fires: a container that restarts once has either
      # crashed or failed a probe, and both are worth a look at this size.
      duration = "0s"

      aggregations {
        alignment_period = "3600s"
        # The increase over the window, not the running total: the metric is
        # cumulative from the container's start, so a delta is what "restarting" is.
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.namespace_name", "resource.label.container_name"]
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "A container in the `${var.app_namespace}` namespace restarted more than ${var.container_restart_threshold} times in the last hour. `kubectl -n ${var.app_namespace} get pods` and `kubectl -n ${var.app_namespace} describe pod <pod>` carry the reason (OOMKilled, a failed readiness probe, a crash at boot); the pod's logs are JSON with the boot lines that say what it was doing. GKE's system containers (`kube-system`, `gke-gmp-system`) are excluded on purpose: they restart once on every Autopilot node replacement, which is normal churn nobody can act on."
  }
}
