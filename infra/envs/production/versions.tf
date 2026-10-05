terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 8.5"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.3"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }

  # Production's state bucket, created by
  # .github/setup/workload-identity.sh. Hardcoded rather than passed with
  # -backend-config: one bucket per project, and the value cannot come from a
  # variable. `terraform init -backend=false` (lint, CI) ignores this block.
  backend "gcs" {
    bucket = "openharness-510710-tfstate"
    prefix = "terraform/state"
  }
}
