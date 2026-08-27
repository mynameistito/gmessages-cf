# Security Model

- Cloudflare Access is the external boundary; production is deny-by-default.
- MCP uses one dedicated stage-specific Service Auth token. Administration is separate and must not be exposed as MCP tools.
- Access assertions are an application service concern. Presence of a header is never authentication; production must validate Cloudflare's signed identity context.
- Google session material is sensitive encrypted ciphertext, not plaintext D1 data. `GMESSAGES_SESSION_KEY` is required at deployment and is bound to the container as a secret, never as plain text.
- Key rotation currently requires stopping the session, replacing the secret, deleting the stored envelope, and explicitly re-pairing; dual-read rotation is not implemented.
- Attachments are private R2 objects and are served only through authenticated application paths.
- Health contains state only: no phone numbers, message contents, participants, tokens, or keys.
- Logs contain operation and safe identifiers, never bodies, full phone numbers, Access secrets, or Google credentials.
- The outbox enforces idempotency and auditable delivery states; the primary Durable Object serializes sends. Personal-client rate limiting remains an operational gap before broad live use.
