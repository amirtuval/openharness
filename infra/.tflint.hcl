# tflint configuration for infra/ (issue #153). tflint walks up from each
# directory it inspects, so this one file covers every module and both
# environments. The google ruleset catches provider-specific mistakes (invalid
# tiers, machine types, versions) that `terraform validate` cannot.
plugin "google" {
  enabled = true
  version = "0.40.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}
