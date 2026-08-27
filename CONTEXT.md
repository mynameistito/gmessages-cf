# Handoff Context

## Objective

Build a production-quality Cloudflare-native Google Messages MCP. Fake mode remains deterministic and is the CI default. Real mode uses the pinned upstream Go `libgm` adapter and must not bypass CAPTCHA, anti-abuse controls, rate limits, device security, or account enforcement.

## Repository And Tooling

- Root: `C:\Users\mynameistito\code\gmessages-cf`
- Package manager: Bun.
- TypeScript and Effect: `4.0.0-rc.110`.
- Formatting/lint: Oxfmt and Ultracite.
- Infrastructure source: `alchemy.run.ts`; do not add Wrangler infrastructure files.
- Workspace root is not itself a Git repository; preserve existing files and user changes.

## Architecture

- `src/worker/worker.ts`: Worker entrypoint and MCP boundary.
- `src/worker/mcp.ts`: list, read, search, and send tools.
- `src/worker/session-coordinator.ts`: primary Durable Object. Serializes real protocol calls, forwards them to the primary container, stores safe status state, and stores encrypted session envelopes.
- `src/services/google-messages.ts`: application provider port.
- `src/services/google-messages-ipc.ts`: validates Go wire data, passes stable idempotency keys, consumes SSE, and reconnects with `Last-Event-ID`.
- `src/services/d1-repository.ts`: D1 persistence, atomic outbox reservation, conversation sync, and batch delivery commit.
- `src/services/storage.ts`: D1 and R2 Effect adapters.
- `gmessages/cmd/server/main.go`: isolated AGPL adapter around upstream libgm.
- `migrations/0001_initial.sql` and `0002_outbox_timestamps.sql`: D1 schema and stale reservation support.

## Authentication

- Local Worker requests default to `accessAuthenticationTest` and require `x-gmessages-test-token`.
- Alchemy deployments default `GMESSAGES_AUTH_MODE` to `access`.
- Access mode validates `Cf-Access-Jwt-Assertion` with `jose`, team-domain JWKS, issuer, and application audience.
- Variables: `GMESSAGES_ACCESS_TEAM_DOMAIN` and `GMESSAGES_ACCESS_AUDIENCE`.
- Local credentials are never accepted in Access mode.

## Real Mode

- Requires `GMESSAGES_MODE=real`, `SESSION_COORDINATOR`, `GMESSAGES_IPC_TOKEN`, and `DB`.
- The Worker calls the primary DO; the DO calls the primary container.
- Go requires `LIBGM_IPC_TOKEN` and `LIBGM_SESSION_KEY`.
- `GMESSAGES_SESSION_KEY` is passed through Alchemy to the container as `LIBGM_SESSION_KEY`; it must be a base64-encoded 32-byte key.
- Go session export/import serializes `libgm.AuthData` and encrypts it with AES-GCM.

## Delivery

- MCP send requires an idempotency key.
- D1 outbox keys are unique and stale pending reservations can be reclaimed.
- The key passes through the provider and IPC layers.
- Go derives a deterministic UUID from conversation ID plus idempotency key for upstream `TmpID`.
- Conversation, participant, message, and outbox completion writes use one D1 batch.
- Provider timeout can still leave uncertainty about upstream acceptance; retries must preserve the same key.

## Events And Recovery

- Go `GET /v1/events` is authenticated SSE with normalized message events, event IDs, keepalives, and subscriber cleanup.
- TypeScript validates `MessageWire`, reconnects after closure, and sends `Last-Event-ID`.
- Durable event cursor storage and inbound D1 deduplication are implemented; old and out-of-order valid events are persisted safely and malformed events do not advance the cursor.
- DO status stores only request count, last activity, and whether an encrypted envelope exists.
- The next event task is advancing the cursor only after durable message persistence.

## Completed Slices

- Pinned upstream source at `v0.2608.0`, commit `9743919f4884327db998fe0f227c073f3f3aceb3`.
- Go IPC health, connect, conversations, messages, send, auth, deterministic IDs, encrypted session endpoints, and SSE.
- Effect provider, D1/R2 seams, D1 repository, outbox behavior, MCP tools, Access JWT layer, and DO coordination.
- Fake-mode collision, provider failure, local auth, Access fallback, encryption, and provider ID tests.

## Current Verification

Passing:

- `bunx tsc --noEmit`
- `bunx ultracite check`
- `bunx oxfmt --check .`
- `bun test`: 9 tests passing
- `go test ./cmd/server`
- `go vet ./cmd/server`

Environment blockers:

- `go test ./...` may require native `olm/olm.h`.
- Docker integration requires Docker Desktop Linux daemon.
- CI uses no Google credentials.

## Open Gaps

- Session key delivery must be treated as a real secret; rotation is not implemented.
- SSE transport and reconnect headers exist, but cursor persistence and inbound D1 ingestion are incomplete.
- Pairing and administration UI remain incomplete; safe lifecycle states and reauthentication reporting are implemented.
- D1, DO, container, restart, Access JWT, and Docker image gates are covered. A deployed Cloudflare integration test remains incomplete.
- Pairing UI and operator administration remain. Metrics and alert definitions are documented, but export and notification routing are deployment-specific.
- Formal legal review and final AGPL source-offer publication remain.

## New Chat Starting Point

Read `PLAN.md`, then continue with deployment-specific integration and operations work. Sections 1 through 6 have implementation coverage; section 7 is documented except for formal legal approval and production source-offer publication. Keep fake mode credential-free and run all verification commands after each slice.
