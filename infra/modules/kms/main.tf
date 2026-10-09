# Cloud KMS key for the vault (issue #153, epic #148 D6): the app uses it
# through OPENHARNESS_KEY_PROVIDER=gcp-kms and OPENHARNESS_KMS_KEY, instead of
# an OPENHARNESS_SECRETS_KEY.

resource "google_kms_key_ring" "ring" {
  project  = var.project_id
  name     = var.key_ring_name
  location = var.region
}

resource "google_kms_crypto_key" "key" {
  name            = var.key_name
  key_ring        = google_kms_key_ring.ring.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = var.rotation_period

  lifecycle {
    # Key rings and their keys cannot be deleted, and destroying this one would
    # make every vault entry written with it unreadable.
    prevent_destroy = true
  }
}

# Resource-level, so the app holds no cloudkms role on the project. It may
# encrypt and decrypt, never administer the key.
resource "google_kms_crypto_key_iam_member" "app" {
  crypto_key_id = google_kms_crypto_key.key.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${var.app_service_account_email}"
}
