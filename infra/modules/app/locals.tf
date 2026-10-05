locals {
  chart_path     = var.chart_path != "" ? var.chart_path : "${path.module}/../../../charts/openharness"
  static_ip_name = var.static_ip_name != "" ? var.static_ip_name : var.release_name

  # The provider's own client ID variables, keyed the way the chart's provider
  # secret names are.
  provider_client_ids = {
    google    = var.google_client_id
    github    = var.github_client_id
    microsoft = var.microsoft_client_id
  }

  provider_secret_envs = {
    google    = "GOOGLE_CLIENT_SECRET"
    github    = "GITHUB_CLIENT_SECRET"
    microsoft = "MICROSOFT_CLIENT_SECRET"
  }

  enabled_providers = [for name, client_id in local.provider_client_ids : name if client_id != ""]

  # Plain, non-secret environment. A provider's client ID is set only when the
  # variable is non-empty; the same condition creates its client secret below.
  env = merge(
    {
      BETTER_AUTH_URL                = "https://${var.host}"
      OPENHARNESS_TRUSTED_PROXY_HOPS = "1"
      OPENHARNESS_KEY_PROVIDER       = "gcp-kms"
      OPENHARNESS_KMS_KEY            = var.kms_key_id
      OPENHARNESS_DEV_LOGIN          = "0"
    },
    var.google_client_id != "" ? { GOOGLE_CLIENT_ID = var.google_client_id } : {},
    var.github_client_id != "" ? { GITHUB_CLIENT_ID = var.github_client_id } : {},
    var.microsoft_client_id != "" ? { MICROSOFT_CLIENT_ID = var.microsoft_client_id } : {},
    var.microsoft_tenant_id != "" ? { MICROSOFT_TENANT_ID = var.microsoft_tenant_id } : {},
  )

  # The chart delivers each of these through the GKE Secret Manager add-on and
  # exports <env>_FILE. A secret listed here without a version blocks the pod
  # from starting, so the provider client secrets appear only when their client
  # ID — and therefore their Secret Manager secret — exists.
  secrets = concat(
    [
      { env = "DATABASE_URL", secret = var.database_url_secret_id },
      { env = "BETTER_AUTH_SECRET", secret = var.better_auth_secret_id },
    ],
    [
      for name in local.enabled_providers : {
        env    = local.provider_secret_envs[name]
        secret = var.provider_secret_ids[name]
      }
    ],
  )

  values = {
    image = {
      repository = var.image_repository
      tag        = var.image_tag
    }
    gcpProject = var.project_id
    serviceAccount = {
      gcpServiceAccount = var.app_service_account_email
    }
    ingress = {
      host         = var.host
      staticIpName = local.static_ip_name
    }
    env     = local.env
    secrets = local.secrets
  }
}
