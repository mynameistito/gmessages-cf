# Local Development

Fake mode is the default and is safe for CI:

```powershell
bun install
bun test
bun alchemy dev
```

CI initializes the pinned adapter submodule before installing from `bun.lock`, then runs TypeScript typechecking, Ultracite, oxfmt, Bun tests, and the adapter package tests/vet. Docker and CGO-dependent adapter checks are separate and nonblocking; run them manually when Docker Desktop and the native headers are available.

The fake Worker, provider, repository, authentication layer, Streamable HTTP MCP transport, and health route require no Google credentials and never send real messages. Use `x-gmessages-test-token: local-mcp-token` only for local tests.

Real mode is not the local default. Copy `.env.example` to `.env` when creating a local environment; the checked-in `.env` contains only fake-mode values. When explicitly enabled, the isolated Go adapter uses localhost HTTP IPC, the pinned upstream source, encrypted session state, and the `GoogleMessages` Effect service. It must not bypass Google protections.

Generate real-mode values outside the repository. `GMESSAGES_SESSION_KEY` must be exactly 32 random bytes encoded with unpadded standard base64. `GMESSAGES_IPC_TOKEN` is an independent random bearer token used only between the Worker/DO boundary and the container.

```bash
export GMESSAGES_SESSION_KEY="$(openssl rand -base64 32 | tr -d '=\n')"
export GMESSAGES_IPC_TOKEN="$(openssl rand -hex 32)"
```

For a real local pairing session, put those values in the gitignored `.env`, set `GMESSAGES_MODE=real`, and restart Alchemy:

```bash
session_key="$(openssl rand -base64 32 | tr -d '=\n')"
ipc_token="$(openssl rand -hex 32)"
printf 'GMESSAGES_AUTH_MODE=test\nGMESSAGES_MODE=real\nGMESSAGES_ACCESS_TEAM_DOMAIN=https://local-development.invalid\nGMESSAGES_ACCESS_AUDIENCE=local-development\nGMESSAGES_ADMIN_HOSTNAME=127.0.0.1\nGMESSAGES_IPC_TOKEN=%s\nGMESSAGES_SESSION_KEY=%s\n' "$ipc_token" "$session_key" > .env
bun alchemy dev --profile mynameistito
```

The command sets `GMESSAGES_ADMIN_HOSTNAME=127.0.0.1` for local pairing. The admin hostname must match the hostname used by the pairing requests; the MCP service token is not accepted on admin routes.

Then use the local admin token to start pairing. The response contains the QR payload URL, not an image. Render it locally with `qrencode` and scan the terminal from Google Messages linked-device settings. Do not paste the URL into an online QR generator:

```bash
sudo apt-get install qrencode jq
curl -sS -X POST http://127.0.0.1:1337/admin/pair/start \
  -H 'x-gmessages-test-token: local-admin-token'
until qr_url="$(curl -sS http://127.0.0.1:1337/admin/pair/status \
  -H 'x-gmessages-test-token: local-admin-token' | jq -r '.qrUrl // empty')" && [ -n "$qr_url" ]; do
  sleep 2
done
printf '%s' "$qr_url" | qrencode -t ANSIUTF8
```

If the installed Google Messages app no longer offers QR pairing, use Gaia account pairing instead. Export the `messages.google.com` authentication cookies from the browser where the Google account is signed in, wrap them in a `cookies` JSON field in `cookies.json`, and submit them only to the local adapter:

```bash
curl -sS -X POST http://127.0.0.1:1337/admin/pair/account/start \
  -H 'content-type: application/json' \
  -H 'x-gmessages-test-token: local-admin-token' \
  --data-binary @cookies.json
```

Poll the same pair status endpoint. Gaia pairing reports `verificationEmoji`; select the matching emoji in the Google Messages confirmation prompt on the phone. Cookie values are credentials: do not commit `cookies.json`, paste it into chat, or send it to a third-party service.

Poll `/admin/pair/status` until `paired` is `true`:

```bash
curl -sS http://127.0.0.1:1337/admin/pair/status \
  -H 'x-gmessages-test-token: local-admin-token'
```

After pairing, use `/mcp` with `x-gmessages-test-token: local-mcp-token`. Keep the same session key when restarting; changing it requires pairing again.

Real mode uses a private Google account session and is not a production-readiness signal. Do not use account cookies or personal message data in tests, commits, logs, screenshots, or support requests. Review `docs/compliance.md` and `docs/licensing.md` before any remote deployment.

`messages.send` requires an idempotency key. The outbox schema has a unique constraint so retries can resume without delivering twice; provider delivery remains outside the database transaction.
