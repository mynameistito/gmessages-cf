# Observability

Metrics and logs must contain operational identifiers only. Never emit message text, phone numbers, cookies, access tokens, session ciphertext, or cryptographic keys.

## Signals

- `gmessages_provider_requests_total{operation,result}` counts connect, list, read, send, and event operations.
- `gmessages_provider_failures_total{operation,retryable}` counts provider failures without recording raw error text.
- `gmessages_event_reconnects_total` counts SSE reconnect attempts.
- `gmessages_event_persistence_failures_total` counts events that could not be committed to D1.
- `gmessages_outbox_pending` is the number of pending or retryable outbox rows.
- `gmessages_outbox_oldest_age_seconds` is the age of the oldest pending or retryable row.
- `gmessages_session_lifecycle{state}` reports only `unpaired`, `paired`, `reauthentication_required`, or `disconnected`.

## Alerts

- Alert when provider failure rate exceeds 10% for 5 minutes.
- Alert when the same session reconnects more than 10 times in 10 minutes.
- Alert when any outbox row remains pending or retryable for more than 10 minutes.
- Alert when event persistence failures occur for 3 consecutive events.
- Alert when a session remains `reauthentication_required` for 15 minutes.

Alerts should link to the deployment stage and operation, not message or account content. Metrics export and notification routing remain deployment-specific.
