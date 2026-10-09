output "uptime_check_id" {
  description = "ID of the uptime check on https://<host>/health, as the console and the alert filter name it."
  value       = google_monitoring_uptime_check_config.health.uptime_check_id
}

output "notification_channel_names" {
  description = "Resource names of the notification channels every alert policy notifies. Empty while alert_email is unset."
  value       = [for channel in google_monitoring_notification_channel.email : channel.name]
}

output "alert_policy_names" {
  description = "Display names of the alert policies created. Empty while alert_email is unset."
  value = [
    for policy in concat(
      google_monitoring_alert_policy.uptime,
      google_monitoring_alert_policy.http_5xx,
      google_monitoring_alert_policy.cloudsql_cpu,
      google_monitoring_alert_policy.cloudsql_disk,
      google_monitoring_alert_policy.container_restarts,
    ) : policy.display_name
  ]
}
