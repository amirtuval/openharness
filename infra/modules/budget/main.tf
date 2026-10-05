# Billing budget with 50/90/100% alerts (issue #153, epic #148 D4).
#
# Optional, behind the environment root's enable_budget: budgets live on the
# billing account, and deploy@ holds no rights there until the maintainer grants
# roles/billing.costsManager on it — see infra/README.md. With the module
# disabled the first apply works without that grant.

resource "google_billing_budget" "budget" {
  billing_account = "billingAccounts/${var.billing_account_id}"
  display_name    = var.display_name

  budget_filter {
    projects = ["projects/${var.project_number}"]
  }

  amount {
    specified_amount {
      currency_code = var.currency_code
      units         = tostring(var.amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.threshold_percents
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }
}
