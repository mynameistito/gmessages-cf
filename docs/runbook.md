# Operations Runbook

## Deploy

1. Set `GMESSAGES_HOSTNAME` to the MCP hostname, `GMESSAGES_ADMIN_HOSTNAME` to a separate admin hostname, and `GMESSAGES_ADMIN_EMAIL` to the sole operator email allowed to pair.
2. Set `GMESSAGES_ACCESS_TEAM_DOMAIN` and `GMESSAGES_ACCESS_AUDIENCE` for the target Cloudflare Access application.
3. Provision `GMESSAGES_SESSION_KEY` as a base64-encoded 32-byte secret. Do not put it in source control, D1, R2, or command history.
4. Set `GMESSAGES_MODE=real` and provision `GMESSAGES_IPC_TOKEN` through the deployment secret mechanism.
5. Review the Alchemy plan, then run `bun alchemy deploy --stage <stage>`.
6. Confirm `/health` is reachable only through the intended Access application and shows no credentials or message data.

## Recover

1. Check adapter `/healthz` for `paired`, `reauthentication_required`, or `disconnected`.
2. If the container restarted, retain the same idempotency keys for uncertain sends and allow the Durable Object to restore the encrypted session envelope.
3. If recovery fails, do not delete the envelope until the failure is classified; re-pair only through the separate operator flow.

## Local Pairing

1. Start `alchemy dev` from WSL with the local `.env` file loaded.
2. Authenticate as the local admin using `x-gmessages-test-token: local-admin-token`.
3. Start pairing:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:1337/admin/pair/start `
  -Headers @{ "x-gmessages-test-token" = "local-admin-token" }
```

4. Poll pairing status until `qrUrl` is present, then render it locally with `qrencode -t ANSIUTF8` and scan the terminal from Google Messages linked-device settings. Never use an online QR generator for this payload.
5. Poll pairing status until `paired` is `true`:

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:1337/admin/pair/status `
  -Headers @{ "x-gmessages-test-token" = "local-admin-token" }
```

6. After pairing, use the normal MCP endpoint with `local-mcp-token`. The Durable Object captures the encrypted session after the status request.

## Rotate

1. Stop real-mode traffic for the session.
2. Replace `GMESSAGES_SESSION_KEY` with a newly generated base64-encoded 32-byte secret.
3. Delete the old encrypted session envelope through the operator storage procedure.
4. Explicitly re-pair the linked device. Dual-read key rotation is not implemented.

## Roll Back

1. Keep the current session secret and D1 database unchanged.
2. Roll back the Worker and container image together through the same Alchemy stage.
3. Preserve the outbox and reuse original idempotency keys after recovery.

## Local Gates

```powershell
docker build --tag gmessages-cf-integration .
bunx tsc --noEmit
bunx ultracite check
bunx oxfmt --check .
bun test
go test ./cmd/server
go vet ./cmd/server
```

The GitHub workflow initializes submodules and runs the TypeScript and adapter gates independently. Docker/CGO integration is intentionally manual or nonblocking so credential-free CI does not depend on Docker Desktop or native `olm` headers.

`go test ./...` additionally requires the native `olm/olm.h` development headers. Docker Desktop Linux must be running for container integration checks.

On Windows, run the full Go gate in disposable Ubuntu Linux when the host does not have the native toolchain:

```powershell
docker run --rm --volume "${PWD}\gmessages:/src" --workdir /src ubuntu:24.04 bash -lc 'apt-get update && apt-get install -y --no-install-recommends golang git libolm-dev libsqlite3-dev build-essential pkg-config ca-certificates && CGO_ENABLED=1 go test ./... && CGO_ENABLED=1 go vet ./...'
```
