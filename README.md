# gmessages-cf

Cloudflare-native Google Messages MCP service. It exposes a small Streamable HTTP MCP surface for one personal, authenticated message session. The default implementation is deterministic fake mode; real mode is explicitly configured and remains subject to the compliance and operational gates in `PLAN.md`.

## Current Slice

This repository currently provides:

- Effect service boundaries for Google Messages and message persistence
- deterministic fake conversations, inbound fixtures, duplicate-safe memory persistence
- MCP tools for listing, reading, searching, and sending
- a Web Standard Streamable HTTP `/mcp` Worker adapter
- `/health` with no message or credential data
- Alchemy-owned Worker, D1, R2, and Durable Object declarations
- D1 schema for messages, sync, attachments, reactions, receipts, and outbox records

The real `libgm` daemon, D1/R2 adapters, Access resources, Durable Object session boundary, encrypted recovery, and event ingestion are implemented behind explicit real-mode configuration. Pairing UI and full integration suites remain future milestones.

## Local Development

Requirements: Bun and Docker Desktop on Windows.

```powershell
bun install
bun run typecheck
bun run check
bun alchemy dev
```

Local development defaults to fake mode and `AccessAuthenticationTest`; it needs no Google account or credentials. Alchemy deployments default to `GMESSAGES_AUTH_MODE=access` and require `GMESSAGES_ACCESS_TEAM_DOMAIN`, `GMESSAGES_ACCESS_AUDIENCE`, and `GMESSAGES_SESSION_KEY` (a base64-encoded 32-byte key). Production validates `Cf-Access-Jwt-Assertion` rather than accepting the local bearer token.

## Architecture

```text
Android Google Messages
        | linked-device protocol (explicit real mode)
        v
Cloudflare Container: isolated AGPL libgm adapter
        | narrow localhost HTTP IPC
        v
Effect application services
        | D1 metadata, R2 private media
        v
Durable Object: primary session ownership
        ^
Worker /mcp: Streamable HTTP + Cloudflare Access
        ^
Hermes: CF-Access-Client-Id / CF-Access-Client-Secret
```

Matrix is not required. `libgm` is a small Go protocol boundary because the upstream implementation is Go and reimplementing Google's private protocol in TypeScript would increase risk and maintenance cost. Application policy, schemas, persistence, authorization, deduplication, and MCP never depend on raw `libgm` structures.

Alchemy is the infrastructure source of truth. Do not add Wrangler infrastructure files. Run `bun alchemy deploy` only after configuring the Cloudflare profile and reviewing the plan.

## Security And Privacy

All remote ingress is intended to be behind a deny-by-default Cloudflare Access application with a dedicated Service Auth policy and stage-specific Service Token. Configure Hermes with the two `CF-Access-*` headers. Never commit or log the client secret; Cloudflare shows it only on creation or rotation. Session material must be encrypted before independent durable storage and is never part of health or MCP responses.

Messages are sensitive data. D1 stores metadata and text; R2 stores private attachment bytes. No public message search, bulk messaging, contact harvesting, or rate-limit evasion is planned. Outbound sends use a transactional outbox, idempotency keys, timeout handling, and auditable failure states.

## Protocol Status

The upstream protocol is unofficial and can change. This project will only use legitimate linked-device authentication. It will not bypass CAPTCHA, anti-abuse controls, rate limits, device security, or account enforcement. See `docs/protocol.md` for the current research record and `docs/licensing.md` for the AGPL boundary.

## Documents

- `PLAN.md`: ordered production-readiness implementation plan
- `CONTEXT.md`: current architecture, decisions, verification state, and new-chat handoff
- `docs/architecture.md`: boundaries, lifecycle, and recovery design
- `docs/security.md`: Access, secrets, storage, and threat model
- `docs/licensing.md`: upstream attribution and AGPL decision
- `docs/compliance.md`: required Terms of Service review checkpoint
- `docs/runbook.md`: deployment, recovery, rotation, rollback, and local gates
- `docs/observability.md`: safe metrics and alert thresholds
- `docs/yaak.md`: Yaak workspace import and local pairing requests
