declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    FILES: R2Bucket
    ASSETS: Fetcher
    SITE_AUTH_SECRET?: string
    AUDIT_SIGNING_KEY?: string
    LRMS_BASE_URL?: string
    DILRMP_BASE_URL?: string
    GEOSERVER_URL?: string
    REGISTRATION_API_URL?: string
    NOTIFICATION_GATEWAY_URL?: string
  }
}
