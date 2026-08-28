# Yaak Collection

Open the `yaak` directory as an existing workspace in Yaak. Select the `Local` environment and verify `base_url`, `admin_token`, and `mcp_token`. The local collection uses one base URL for both surfaces; remote deployments must use the separate admin and MCP hostnames described in `docs/deployment.md`.

Use `Start Pairing`, then repeatedly send `Pair Status` until its response contains `qrUrl`. Yaak does not render terminal QR codes; copy the value into WSL and run:

```bash
printf '%s' 'PASTE_QR_URL_HERE' | qrencode -t ANSIUTF8
```

Scan the terminal QR code in Google Messages linked-device settings. After pairing, use the MCP requests. The `Send Message` request has a fixed idempotency key and should only be sent intentionally.

For Gaia account pairing, treat the cookie payload as a credential: keep it local, never commit or share it, and clear it after the pairing flow. Real mode is unofficial and experimental; review the repository disclaimer and compliance documents before using it outside local development.
