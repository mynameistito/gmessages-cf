# Protocol Research

The reviewed upstream `pkg/libgm` API exposes `NewAuthData`, `NewClient`, `FetchConfig`, `Connect`, `Reconnect`, `Disconnect`, `SetEventHandler`, `SendMessage`, reactions, read state, media upload/download, and `Unpair`.

`AuthData` is JSON-oriented and must persist request crypto, refresh key, browser/mobile devices, Tachyon token metadata, web encryption key, session/pairing IDs, destination registration ID, and cookies. A transient pairing session is not sufficient for restart recovery. `Connect` refreshes expiring Tachyon credentials and starts long polling.

Inbound SSE events are accepted only after `MessageWire` validation. Malformed or unknown event payloads are ignored and do not advance the cursor. Duplicate events are deduplicated by `protocol_events.external_id`; old and out-of-order valid events are safely persisted because message and external identifiers are unique, while the cursor advances only after the event's durable write batch succeeds.

The adapter reports only safe lifecycle state through `/healthz`: `unpaired`, `paired`, `reauthentication_required`, or `disconnected`. Pairing and reauthentication are operator flows outside MCP; health never returns QR data, provider errors, account identifiers, or session material.

The Go adapter normalizes protobuf events into the narrow IPC contract. Unknown events are rejected at the TypeScript boundary without crashing the daemon. Pairing and real mode remain gated by explicit configuration, operational readiness, and the compliance review.

Compatibility guardrail: legitimate protocol compatibility work is allowed; bypassing CAPTCHA, anti-abuse, account enforcement, rate limits, or explicit security controls is not.
