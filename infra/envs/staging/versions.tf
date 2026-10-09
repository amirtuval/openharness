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

  # The bucket and prefix are hardcoded per environment rather than passed with
  # -backend-config: each environment owns exactly one bucket, created by
  # .github/setup/workload-identity.sh (<project-id>-tfstate), and the value
  # cannot be derived from a variable here. `terraform init -backend=false`
  # (lint, CI) ignores this block.
  backend "gcs" {
    bucket = "openharness-dev-tfstate"
    prefix = "terraform/state"
  }
}
