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
  description = "Budget amount per month, in whole currency units, *in the billing account's currency* unless `currency_code` is set — see that variable."
  type        = number
  default     = 100

  validation {
    condition     = var.amount > 0
    error_message = "The budget amount must be greater than zero."
  }
}

variable "currency_code" {
  description = "ISO 4217 currency code of the budget amount, or null (the default) to leave the amount in the billing account's own currency. Only set it to the account's currency: the Budgets API rejects a budget whose currency does not match the account's with a 400 (`Request contains an invalid argument`), and `gcloud billing accounts describe` is what reports it — ILS for the account this epic deploys against (#159)."
  type        = string
  default     = null

  validation {
    condition     = var.currency_code == null || can(regex("^[A-Za-z]{3}$", var.currency_code))
    error_message = "The currency code must be null or a three-letter ISO 4217 code (for example ILS or USD)."
  }
}

variable "threshold_percents" {
  description = "Alert thresholds, as fractions of the budget (0.5 is 50%)."
  type        = list(number)
  default     = [0.5, 0.9, 1.0]
}
