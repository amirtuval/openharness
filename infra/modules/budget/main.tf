# Billing budget with 50/90/100% alerts (issue #153, epic #148 D4).
#
# Optional, behind the environment root's enable_budget: budgets live on the
# billing account, and deploy@ holds no rights there until the maintainer grants
# roles/billing.costsManager on it — see infra/README.md. With the module
# disabled the first apply works without that grant.

locals {
  # The API's own form is `billingAccounts/{id}` — see the request path in
  # https://cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets —
  # and the provider writes that prefix itself: the generated URL is
  # `billingAccounts/{{billing_account}}/budgets`. So the resource wants the **bare** ID, and
  # prefixing it here made the provider ask for
  # `billingAccounts/billingAccounts/0107DE-963D05-222D0A/budgets`, which the API answers with
  # a 404 (#159). Accept either form and normalise: a caller who pastes the prefixed form
  # still works.
  billing_account_id = trimprefix(var.billing_account_id, "billingAccounts/")
}

resource "google_billing_budget" "budget" {
  billing_account = local.billing_account_id
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
