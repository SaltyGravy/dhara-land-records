declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    FILES: R2Bucket
    ASSETS: Fetcher
    SITE_AUTH_SECRET?: string
    AUDIT_SIGNING_KEY?: string
    DOCUMENT_ENCRYPTION_KEY?: string
    MALWARE_SCAN_URL?: string
    MALWARE_SCAN_TOKEN?: string
    LRMS_BASE_URL?: string
    LRMS_API_TOKEN?: string
    DILRMP_BASE_URL?: string
    DILRMP_API_TOKEN?: string
    GEOSERVER_URL?: string
    GEOSERVER_API_TOKEN?: string
    REGISTRATION_API_URL?: string
    REGISTRATION_API_TOKEN?: string
    NOTIFICATION_GATEWAY_URL?: string
    NOTIFICATION_GATEWAY_TOKEN?: string
    OIDC_ISSUER?: string
    OIDC_CLIENT_ID?: string
    OIDC_CLIENT_SECRET?: string
    OIDC_REDIRECT_URI?: string
  }
}
