# Billing budget with 50/90/100% alerts (issue #153, epic #148 D4).
#
# Optional, behind the environment root's enable_budget: budgets live on the
# billing account, and deploy@ holds no rights there until the maintainer grants
# roles/billing.costsManager on it — see infra/README.md. With the module
# disabled the first apply works without that grant.
#
# `amount` is in the **billing account's currency** unless `currency_code` is
# set. The Budgets API documents `Money.currencyCode` as optional, and it "must
# match the currency of the billing account" when given
# (https://cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets);
# omitted, the account's currency is used. A default of "USD" against the ILS
# account this epic deploys on is what the first staging deploy was rejected
# with — `400: Request contains an invalid argument` (#159).

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
      # Null (the default) is omitted from the request, not sent as an empty
      # string: the provider expands `specified_amount` through
      # `expandBillingBudgetsBudgetAmountSpecifiedAmount`, which only sets
      # `currencyCode` when the value is non-empty (hashicorp/google 8.5.0,
      # google/services/billingbudgets/resource_billing_budget.go). With no
      # `currencyCode` in the body the API uses the billing account's currency.
      # Passing the caller's code here is still only safe when it matches the
      # account — see the module header and the variable.
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
