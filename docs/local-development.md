# Local Development

Fake mode is the default and is safe for CI:

```powershell
bun install
bun test
bun alchemy dev
```

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
printf 'GMESSAGES_AUTH_MODE=test\nGMESSAGES_MODE=real\nGMESSAGES_ACCESS_TEAM_DOMAIN=https://local-development.invalid\nGMESSAGES_ACCESS_AUDIENCE=local-development\nGMESSAGES_IPC_TOKEN=%s\nGMESSAGES_SESSION_KEY=%s\n' "$ipc_token" "$session_key" > .env
bun alchemy dev --profile mynameistito
```

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

Poll `/admin/pair/status` until `paired` is `true`:

```bash
curl -sS http://127.0.0.1:1337/admin/pair/status \
  -H 'x-gmessages-test-token: local-admin-token'
```

After pairing, use `/mcp` with `x-gmessages-test-token: local-mcp-token`. Keep the same session key when restarting; changing it requires pairing again.

`messages.send` requires an idempotency key. The outbox schema has a unique constraint so retries can resume without delivering twice; provider delivery remains outside the database transaction.
