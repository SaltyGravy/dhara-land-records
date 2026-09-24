"""Power BI Embedded, "app owns data" flow: a service principal (an Azure AD app
registration, not an interactive user) authenticates once with client-credentials, then
asks Power BI for a short-lived embed token scoped to one report. The frontend hands that
token straight to Microsoft's powerbi-client library - we never hold or proxy report data
ourselves, only the token exchange.

Needs five environment variables (POWERBI_TENANT_ID, POWERBI_CLIENT_ID,
POWERBI_CLIENT_SECRET, POWERBI_WORKSPACE_ID, POWERBI_REPORT_ID) from an Azure AD app
registration that has been added as a member of the target workspace - see the setup
walkthrough in project notes. Mirrors the LRMS/DILRMP connectors in app.py: report
"not configured" rather than failing when they're absent, so a demo without Power BI set
up still starts cleanly.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

AAD_TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
POWERBI_API = "https://api.powerbi.com/v1.0/myorg"
ENV_VARS = ("POWERBI_TENANT_ID", "POWERBI_CLIENT_ID", "POWERBI_CLIENT_SECRET", "POWERBI_WORKSPACE_ID", "POWERBI_REPORT_ID")


def _config() -> dict[str, str] | None:
    values = {name: os.getenv(name, "") for name in ENV_VARS}
    return values if all(values.values()) else None


def is_configured() -> bool:
    return _config() is not None


def _post_form(url: str, fields: dict[str, str]) -> dict:
    body = urllib.parse.urlencode(fields).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def _request_json(url: str, token: str, payload: dict | None = None) -> dict:
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        method="POST" if payload is not None else "GET",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def get_embed_info() -> dict:
    """{configured: False, message} until the five POWERBI_* variables are set; otherwise
    {configured: True, embed_url, report_id, access_token, expiration} for the frontend to
    hand directly to powerbi-client, or {configured: True, error: True, message} if Azure AD
    or the Power BI REST API rejected the exchange (bad secret, app not in the workspace,
    workspace has no Premium/PPU capacity, etc.)."""
    config = _config()
    if not config:
        return {
            "configured": False,
            "message": "Power BI is not connected. Set POWERBI_TENANT_ID, POWERBI_CLIENT_ID, "
                        "POWERBI_CLIENT_SECRET, POWERBI_WORKSPACE_ID, and POWERBI_REPORT_ID.",
        }
    try:
        aad_token = _post_form(AAD_TOKEN_URL.format(tenant=config["POWERBI_TENANT_ID"]), {
            "grant_type": "client_credentials",
            "client_id": config["POWERBI_CLIENT_ID"],
            "client_secret": config["POWERBI_CLIENT_SECRET"],
            "scope": "https://analysis.windows.net/powerbi/api/.default",
        })["access_token"]
        report_url = f"{POWERBI_API}/groups/{config['POWERBI_WORKSPACE_ID']}/reports/{config['POWERBI_REPORT_ID']}"
        report = _request_json(report_url, aad_token)
        embed_token = _request_json(f"{report_url}/GenerateToken", aad_token, {"accessLevel": "View"})
        return {
            "configured": True,
            "embed_url": report["embedUrl"],
            "report_id": report["id"],
            "access_token": embed_token["token"],
            "expiration": embed_token["expiration"],
        }
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        return {"configured": True, "error": True, "message": f"Power BI rejected the request (HTTP {exc.code}): {detail}"}
    except (urllib.error.URLError, KeyError, json.JSONDecodeError) as exc:
        return {"configured": True, "error": True, "message": f"Power BI request failed: {exc}"}
