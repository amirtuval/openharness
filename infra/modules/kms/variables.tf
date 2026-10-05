variable "project_id" {
  description = "GCP project ID the key ring lives in (never the display name)."
  type        = string
}

variable "region" {
  description = "Location of the key ring, us-central1 for every openharness environment."
  type        = string
  default     = "us-central1"
}

variable "key_ring_name" {
  description = "Key ring name. It is part of OPENHARNESS_KMS_KEY's resource path."
  type        = string
  default     = "openharness"
}

variable "key_name" {
  description = "Crypto key name. It is part of OPENHARNESS_KMS_KEY's resource path."
  type        = string
  default     = "credentials"
}

variable "rotation_period" {
  description = "Automatic rotation period, as a duration string. 90 days."
  type        = string
  default     = "7776000s"
}

variable "app_service_account_email" {
  description = "Email of the app service account granted cryptoKeyEncrypterDecrypter on the key."
  type        = string
}
