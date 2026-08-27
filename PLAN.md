# Implementation Plan

Read `CONTEXT.md` first. Execute these sections in order.

## 1. Finish Session Recovery

- Configure `GMESSAGES_SESSION_KEY` as a real deployment secret.
- Verify it reaches the Go container and fail closed for missing or malformed keys.
- Add Durable Object restart tests for export, import, tampering, and provider replacement.
- Define key rotation as dual-read migration or explicit re-pair.

Completion: a restarted container restores valid `libgm.AuthData`; tampered ciphertext is rejected; plaintext session material is absent from logs, D1, R2, health, and MCP responses.

## 2. Complete Event Ingestion

- Persist reconnect cursors using `sync_state` or `protocol_events`.
- Persist normalized inbound messages and conversation updates in D1.
- Deduplicate by stable external ID before writing.
- Define malformed, unknown, old, and out-of-order event behavior.
- Add end-to-end SSE tests through Go, the coordinator, and TypeScript.

Completion: reconnects neither lose accepted events nor create duplicate messages, and cursors advance only after durable persistence.

## 3. Harden Outbound Delivery

- Verify the deterministic provider temporary ID is honored upstream.
- Add pending, sent, failed, and retryable outbox states.
- Add bounded per-session concurrency and personal-client rate limits.
- Recover stale pending rows and provider timeouts.
- Test uncertain provider acceptance and retry behavior.

Completion: Worker retries, DO retries, and container restarts produce at most one accepted delivery per key with an auditable final state.

## 4. Finish Real Provider Lifecycle

- Handle pairing, expiry, reauthentication, reconnect, and fatal libgm events.
- Expose safe connected, paired, and reauthentication-required states.
- Add administration flows outside MCP tools.

Completion: fresh, expired, and restarted sessions reach defined safe states without manual process access.

## 5. Verify Cloudflare Access

- Configure team domain and audience per deployed Access application.
- Test valid, missing, expired, wrong-issuer, and wrong-audience JWTs.
- Confirm direct Worker access cannot bypass Access.
- Keep Service Auth policy scoped to the intended stage.

Completion: production accepts only a valid assertion for the configured audience; local accepts only the local test layer.

## 6. Build Integration Gates

- Add D1 tests with a Worker-compatible SQLite runtime.
- Add Durable Object serialization and restart tests.
- Add container IPC tests for auth, IDs, recovery, and SSE.
- Run Docker integration with Docker Desktop Linux enabled.
- Install native `olm/olm.h` prerequisites and run `go test ./...`.

Completion: credential-free local gates pass and real-mode failures are reproducible and classified.

## 7. Close Operations And Compliance

- Complete the dated Google/libgm Terms of Service review.
- Complete AGPL source-offer and attribution handling.
- Add runbooks for secrets, Access, pairing, recovery, rollback, and rotation.
- Add safe metrics and alerts for provider failures, stale outbox rows, reconnect loops, and missing persistence.
- Reconcile stale `docs/deployment.md` and `docs/protocol.md` statements.

Completion: an operator can deploy, pair, recover, rotate, roll back, and satisfy documented legal and source obligations.

## Verification

```powershell
bunx tsc --noEmit
bunx ultracite check
bunx oxfmt --check .
bun test
```

```powershell
go test ./cmd/server
go vet ./cmd/server
go test ./...
```
