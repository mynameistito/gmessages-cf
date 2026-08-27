# Deployment

Alchemy is the infrastructure source of truth. Set the Cloudflare profile, choose a stage, and review the plan before deploying:

```powershell
bun install
bun alchemy deploy --stage production
```

Set `GMESSAGES_HOSTNAME` to the existing custom hostname. The stack disables `workers.dev`; when the hostname is set, Alchemy creates a self-hosted Access application and attaches it to the Worker.

The stack creates one stage-specific service token and a dedicated `non_identity` Service Auth policy. Configure Hermes with `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Rotate by incrementing `clientSecretVersion`, distribute the new secret, then retire the old secret after `previousClientSecretExpiresAt`.

The primary Durable Object serializes session ownership, reconnects, outbound operations, and container restart coordination. Container storage is disposable. Real mode must encrypt session material before storing it; fake mode never creates or needs Google credentials.

Set `GMESSAGES_MODE=real`, `GMESSAGES_IPC_TOKEN`, and `GMESSAGES_SESSION_KEY` for the real adapter. Real mode requires a paired encrypted session envelope; pairing and reauthentication are separate operator flows and are not exposed through MCP.
