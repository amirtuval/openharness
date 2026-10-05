output "budget_id" {
  description = "Billing budget resource ID."
  value       = google_billing_budget.budget.id
}

output "budget_name" {
  description = "Billing budget resource name."
  value       = google_billing_budget.budget.name
}
