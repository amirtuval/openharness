output "key_ring_id" {
  description = "Full key ring resource name."
  value       = google_kms_key_ring.ring.id
}

output "crypto_key_id" {
  description = "Full crypto key resource name, projects/<p>/locations/<region>/keyRings/openharness/cryptoKeys/credentials — the value of OPENHARNESS_KMS_KEY. Not a version."
  value       = google_kms_crypto_key.key.id
}
