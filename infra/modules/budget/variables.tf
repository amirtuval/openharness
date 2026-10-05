variable "billing_account_id" {
  description = "Billing account ID (the part after billingAccounts/). The maintainer grants roles/billing.costsManager on it to deploy@ before enabling the budget."
  type        = string
}

variable "project_number" {
  description = "Project number the budget is scoped to, from the google_project data source."
  type        = string
}

variable "display_name" {
  description = "Budget display name."
  type        = string
}

variable "amount" {
  description = "Budget amount per month, in whole currency units."
  type        = number
  default     = 100

  validation {
    condition     = var.amount > 0
    error_message = "The budget amount must be greater than zero."
  }
}

variable "currency_code" {
  description = "ISO currency code of the budget amount."
  type        = string
  default     = "USD"
}

variable "threshold_percents" {
  description = "Alert thresholds, as fractions of the budget (0.5 is 50%)."
  type        = list(number)
  default     = [0.5, 0.9, 1.0]
}
