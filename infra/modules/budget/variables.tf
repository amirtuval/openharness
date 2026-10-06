variable "billing_account_id" {
  description = "Billing account ID the budget is created on, bare (`XXXXXX-XXXXXX-XXXXXX`, the ACCOUNT_ID column of `gcloud billing accounts list`) or with a leading `billingAccounts/`, which is stripped. The maintainer grants roles/billing.costsManager on it to deploy@ before enabling the budget."
  type        = string

  # `XXXXXX-XXXXXX-XXXXXX` after trimming, or the empty string: the module is behind the
  # environment root's enable_budget, and that root always passes the variable — as "" when
  # the budget is off, which is the default. A validation rule is checked even for a
  # `count = 0` module (terraform validate, 1.9.8), so a pattern-only rule would reject the
  # disabled configuration; empty is the one value besides the format that is legitimate.
  # GCP prints the ID uppercase (`0107DE-…`) but the IDs are hex and match case-insensitively;
  # `(?i)` keeps a lowercase paste from failing validation for a value the API would accept.
  validation {
    condition = (
      trimprefix(var.billing_account_id, "billingAccounts/") == "" ||
      can(regex("(?i)^[a-z0-9]{6}-[a-z0-9]{6}-[a-z0-9]{6}$", trimprefix(var.billing_account_id, "billingAccounts/")))
    )
    error_message = "The billing account ID must be either empty or the bare ID, formatted XXXXXX-XXXXXX-XXXXXX (for example 0107DE-963D05-222D0A) — a leading `billingAccounts/` is accepted and stripped."
  }
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
