# Deployment

Alchemy is the infrastructure source of truth. Set the Cloudflare profile, choose a stage, and review the plan before deploying:

```powershell
bun install
bun alchemy deploy --stage production
```

Set `GMESSAGES_HOSTNAME` to the existing MCP custom hostname, `GMESSAGES_ADMIN_HOSTNAME` to a separate existing admin hostname, and `GMESSAGES_ADMIN_EMAIL` to the one operator email allowed to pair. The stack disables `workers.dev`; Alchemy creates a service-token-only self-hosted Access application for the MCP hostname and a separate one-hour, email-scoped Access application for the admin hostname.

The stack creates one stage-specific service token and a dedicated `non_identity` Service Auth policy. Configure Hermes with `CF-Access-Client-Id` and `CF-Access-Client-Secret`; do not use that token on the admin hostname. Rotate by incrementing `clientSecretVersion`, distribute the new secret, then retire the old secret after `previousClientSecretExpiresAt`.

The primary Durable Object serializes session ownership, reconnects, outbound operations, and container restart coordination. Container storage is disposable. Real mode must encrypt session material before storing it; fake mode never creates or needs Google credentials.

Set `GMESSAGES_MODE=real`, `GMESSAGES_IPC_TOKEN`, and `GMESSAGES_SESSION_KEY` for the real adapter. Clone with `git clone --recurse-submodules` or run `git submodule update --init --recursive` before building so the pinned `gmessages` source is present. Real mode requires a paired encrypted session envelope; pairing and reauthentication are separate operator flows and are not exposed through MCP.

## Release Metadata

The exact source revisions for this release are available at these public commit URLs:

- Adapter: https://github.com/mynameistito/gmessages-cf/commit/93c9ea8e92959d48c3d94daf0130d7c3777ef5f5
- Pinned upstream: https://github.com/mautrix/gmessages/commit/9743919f4884327db998fe0f227c073f3f3aceb3

The final network source-offer notice and hosting arrangement remain subject to legal review. Do not enable public real mode until that review and the remaining integration and operational gates are complete.
