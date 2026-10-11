variable "project_id" {
  description = "GCP project ID the monitored resources live in (never the display name)."
  type        = string
}

variable "host" {
  description = "Public hostname the uptime check probes, e.g. staging.oharness.dev. The check is HTTPS on this host."
  type        = string
}

variable "alert_email" {
  description = "Address the alerts are emailed to. Empty creates no notification channel and no alert policies, so the first apply succeeds before anyone has decided who is on call."
  type        = string
  default     = ""
}

variable "name_prefix" {
  description = "Prefix for every resource's display name, so the two environments' policies read apart in the console."
  type        = string
  default     = "openharness"
}

variable "uptime_check_path" {
  description = "Path the uptime check requests. `/health` is liveness: 200 while the process is alive and draining included (see the server's `app.ts`)."
  type        = string
  default     = "/health"
}

variable "uptime_check_period" {
  description = "How often the uptime check runs. Five minutes is the documented cadence and well inside the free tier."
  type        = string
  default     = "300s"
}

variable "uptime_check_timeout" {
  description = "How long the uptime check waits for an answer before counting the probe as failed. Must not exceed the period."
  type        = string
  default     = "10s"
}

variable "http_5xx_threshold" {
  description = "Load-balancer 5xx responses per second, averaged over the alert window, before the policy fires."
  type        = number
  default     = 1
}

variable "db_cpu_threshold" {
  description = "Cloud SQL CPU utilization (0..1) above which the policy fires."
  type        = number
  default     = 0.8
}

variable "db_disk_threshold" {
  description = "Cloud SQL disk utilization (0..1) above which the policy fires."
  type        = number
  default     = 0.8
}

variable "app_namespace" {
  description = "Kubernetes namespace the app runs in. Only its containers are paged on when they restart: GKE's own system DaemonSets restart once on every Autopilot node replacement, which is not something we can act on (issue #325)."
  type        = string
  default     = "openharness"
}

variable "container_restart_threshold" {
  description = "Container restarts within the alert window above which the policy fires. Zero means 'any restart at all'."
  type        = number
  default     = 0
}
