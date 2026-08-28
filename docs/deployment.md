# Deployment

This service has two separate authentication layers:

- Cloudflare Access protects the public HTTP endpoints.
- Google Messages pairing authenticates the linked-device session inside the service.

These are different credentials. A Cloudflare Access token cannot replace Google pairing cookies, and Google cookies must never be used as an MCP or Cloudflare credential.

## Prerequisites

Before deploying, install Bun, Docker Desktop, Git, and the Cloudflare account tools required by Alchemy. Clone the repository with its pinned upstream source:

```powershell
git clone --recurse-submodules https://github.com/mynameistito/gmessages-cf.git
Set-Location gmessages-cf
bun install
```

Authenticate Alchemy with the Cloudflare account that owns the target resources, and make sure the account can create Workers, Containers, D1, R2, Durable Objects, and Access applications. Keep the MCP and admin hostnames separate, for example `messages-mcp.example.com` and `messages-admin.example.com`.

## Configuration

Set these values in the deployment environment or provide them through Alchemy's secret/configuration prompt. Do not commit a `.env` file or put secrets in shell history.

| Variable | Value |
| --- | --- |
| `GMESSAGES_HOSTNAME` | Existing hostname for `/mcp` and authenticated `/health` |
| `GMESSAGES_ADMIN_HOSTNAME` | Different hostname for `/admin/pair/*` |
| `GMESSAGES_ADMIN_EMAIL` | One operator email allowed to pair |
| `GMESSAGES_ACCESS_TEAM_DOMAIN` | Your Cloudflare Access team URL, such as `https://team.cloudflareaccess.com` |
| `GMESSAGES_ACCESS_AUDIENCE` | Audience value from the MCP Access application |
| `GMESSAGES_AUTH_MODE` | `access` for a deployment |
| `GMESSAGES_MODE` | `fake` for a smoke test, `real` for Google Messages |
| `GMESSAGES_IPC_TOKEN` | Random private token used only by the Worker/container boundary |
| `GMESSAGES_SESSION_KEY` | Exactly 32 random bytes, encoded as unpadded standard base64 |

Generate the two secret values without checking them into the repository:

```powershell
$sessionBytes = [byte[]]::new(32)
$ipcBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($sessionBytes)
[Security.Cryptography.RandomNumberGenerator]::Fill($ipcBytes)
$sessionKey = [Convert]::ToBase64String($sessionBytes).TrimEnd('=')
$ipcToken = [Convert]::ToHexString($ipcBytes).ToLowerInvariant()
```

Use independent random values if generating them separately. Keep the session key permanently: changing it makes the encrypted paired session unreadable and requires pairing again.

## Deploy

Alchemy is the infrastructure source of truth. Configure the target stage, review the plan, and deploy only after the release gates are complete:

```powershell
bun install
bun alchemy deploy --stage production
```

Set `GMESSAGES_HOSTNAME` to the existing MCP custom hostname, `GMESSAGES_ADMIN_HOSTNAME` to a separate existing admin hostname, and `GMESSAGES_ADMIN_EMAIL` to the one operator email allowed to pair. The stack disables `workers.dev`; Alchemy creates a service-token-only self-hosted Access application for the MCP hostname and a separate one-hour, email-scoped Access application for the admin hostname.

The stack creates one stage-specific service token and a dedicated `non_identity` Service Auth policy. Configure Hermes with `CF-Access-Client-Id` and `CF-Access-Client-Secret`; do not use that token on the admin hostname. Rotate by incrementing `clientSecretVersion`, distribute the new secret, then retire the old secret after `previousClientSecretExpiresAt`.

The primary Durable Object serializes session ownership, reconnects, outbound operations, and container restart coordination. Container storage is disposable. Real mode must encrypt session material before storing it; fake mode never creates or needs Google credentials.

Set `GMESSAGES_MODE=real`, `GMESSAGES_IPC_TOKEN`, and `GMESSAGES_SESSION_KEY` for the real adapter. Clone with `git clone --recurse-submodules` or run `git submodule update --init --recursive` before building so the pinned `gmessages` source is present. Real mode requires a paired encrypted session envelope; pairing and reauthentication are separate operator flows and are not exposed through MCP.

The MCP hostname accepts only the stage Service Auth token. The admin hostname accepts only the configured operator email through Cloudflare Access and is the sole public route for `/admin/pair/start`, `/admin/pair/status`, and `/admin/pair/account/start`. Keep the hostnames separate and never send the MCP service token to admin routes. `/health` is authenticated and reports only coarse service state.

## Pair Google Messages

Pair only after the deployment is healthy. Open the admin hostname in a browser and sign in to Cloudflare Access with `GMESSAGES_ADMIN_EMAIL`. Use that hostname for all pairing requests; use the MCP hostname only for MCP clients.

QR pairing is preferred when Google Messages offers it:

1. `POST https://<admin-hostname>/admin/pair/start`.
2. Poll `GET https://<admin-hostname>/admin/pair/status` until `qrUrl` is returned.
3. Render the URL locally with `qrencode -t ANSIUTF8` and scan it from Google Messages linked-device settings. Never use an online QR generator.
4. Poll status until `paired` is `true`.

If QR pairing is unavailable, use the Gaia account-pairing endpoint. In the same browser profile where the Google account is signed in, open `https://messages.google.com`, then open browser developer tools and go to **Application > Storage > Cookies > https://messages.google.com**. Export the cookie **names and values** as a JSON object in this shape:

```json
{
  "cookies": {
    "SID": "...",
    "HSID": "...",
    "SSID": "..."
  }
}
```

Do not export cookies from another site, include them in screenshots, or paste them into chat. Save the file locally as the gitignored `cookies.json`, send it only in the authenticated request to `POST https://<admin-hostname>/admin/pair/account/start`, then delete it securely. Poll `/admin/pair/status`; when `verificationEmoji` appears, select the matching emoji in the Google Messages confirmation prompt on the phone.

Google session cookies are equivalent to account credentials. If they were committed, shared, or exposed in logs, sign out the browser session and revoke/rotate the affected Google sessions before continuing.

## Verify

Configure Hermes or the MCP client with the stage-specific Cloudflare Access Service Auth headers (`CF-Access-Client-Id` and `CF-Access-Client-Secret`). Do not send those headers, or the MCP service token, to the admin pairing routes. Confirm `/health` and an MCP request work through the MCP hostname, and confirm the admin hostname rejects unauthorized users.

## Release Metadata

The exact source revisions for this release are available at these public commit URLs:

- Adapter: https://github.com/mynameistito/gmessages-cf/commit/93c9ea8e92959d48c3d94daf0130d7c3777ef5f5
- Pinned upstream: https://github.com/mautrix/gmessages/commit/9743919f4884327db998fe0f227c073f3f3aceb3

The final network source-offer notice and hosting arrangement remain subject to legal review. Do not enable public real mode until that review and the remaining integration and operational gates are complete.
