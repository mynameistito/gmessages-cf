import { Effect, Layer, Schema } from "effect";

import { ParticipantId } from "../domain/message";
import type { Conversation, Message } from "../domain/message";
import { D1 } from "./d1-service";
import type { D1Service } from "./d1-service";
import type { GoogleMessageEvent } from "./google-messages";
import { MessageRepository } from "./repositories";
import type { MessageRepositoryService } from "./repositories";
import { RepositoryError } from "./repository-error";

interface ConversationRow {
  readonly id: string;
  readonly title: string;
  readonly last_message_at: string;
  readonly unread_count: number;
  readonly participant_ids: string | null;
}

interface MessageRow {
  readonly conversation_id: string;
  readonly external_id: string;
  readonly id: string;
  readonly outgoing: number;
  readonly sender_id: string;
  readonly sent_at: string;
  readonly text: string;
  readonly transport: Message["transport"];
}

const toMessage = (row: MessageRow): Message => ({
  // SAFETY: rows are selected from the schema's message identifier columns.
  conversationId: row.conversation_id as Message["conversationId"],
  externalId: row.external_id,
  // SAFETY: rows are selected from the schema's message identifier columns.
  id: row.id as Message["id"],
  outgoing: row.outgoing !== 0,
  // SAFETY: rows are selected from the schema's participant identifier columns.
  senderId: row.sender_id as Message["senderId"],
  sentAt: new Date(row.sent_at),
  text: row.text,
  transport: row.transport,
});

const repositoryError = (operation: string, cause: unknown) =>
  new RepositoryError({ cause: String(cause), operation });

const toParticipantId = Schema.decodeUnknownSync(ParticipantId);

const toParticipantIds = (
  participantIds: string | null
): Conversation["participantIds"] =>
  (participantIds?.split(",") ?? []).map((participantId) =>
    toParticipantId(participantId)
  );

const queryMessages = (
  database: D1Service,
  query: string,
  ...parameters: readonly unknown[]
) =>
  Effect.gen(function* readMessages() {
    const rows = yield* database.all<MessageRow>(query, ...parameters);
    return rows.map(toMessage);
  }).pipe(Effect.mapError((cause) => repositoryError("messages.query", cause)));

/** D1-backed repository. Outbox uniqueness makes reservation atomic across isolates. */
export const messageRepositoryD1 = (staleAfterMs = 300_000) =>
  Layer.effect(
    MessageRepository,
    Effect.gen(function* makeRepository() {
      const database = yield* Effect.service(D1);
      const reservationCutoff = () =>
        new Date(Date.now() - staleAfterMs).toISOString();
      const service: MessageRepositoryService = {
        commitDelivery: (idempotencyKey, message) =>
          database
            .batch([
              {
                parameters: [
                  message.conversationId,
                  message.conversationId,
                  message.sentAt.toISOString(),
                ],
                query:
                  "INSERT INTO conversations (id, title, last_message_at, unread_count) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET last_message_at = excluded.last_message_at",
              },
              {
                parameters: [message.senderId, message.senderId],
                query:
                  "INSERT OR IGNORE INTO participants (id, address) VALUES (?, ?)",
              },
              {
                parameters: [message.conversationId, message.senderId],
                query:
                  "INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_id) VALUES (?, ?)",
              },
              {
                parameters: [
                  message.id,
                  message.conversationId,
                  message.senderId,
                  message.externalId,
                  message.text,
                  message.transport,
                  message.sentAt.toISOString(),
                  message.outgoing ? 1 : 0,
                ],
                query:
                  "INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, external_id, text, transport, sent_at, outgoing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              },
              {
                parameters: [
                  message.externalId,
                  new Date().toISOString(),
                  idempotencyKey,
                ],
                query:
                  "UPDATE outbox SET status = 'completed', external_id = ?, updated_at = ? WHERE idempotency_key = ? AND status = 'pending'",
              },
            ])
            .pipe(
              Effect.mapError((cause) =>
                repositoryError("delivery.commit", cause)
              ),
              Effect.asVoid
            ),
        failDelivery: (idempotencyKey, reason, retryable) =>
          database
            .run(
              "UPDATE outbox SET status = ?, last_error = ?, retry_count = retry_count + 1, updated_at = ? WHERE idempotency_key = ? AND status = 'pending'",
              retryable ? "retryable" : "failed",
              reason.slice(0, 256),
              new Date().toISOString(),
              idempotencyKey
            )
            .pipe(
              Effect.mapError((cause) => repositoryError("outbox.fail", cause)),
              Effect.asVoid
            ),
        findByIdempotencyKey: (idempotencyKey) =>
          Effect.gen(function* findByIdempotencyKey() {
            const row = yield* database.first<{
              external_id: string | null;
              status: string;
            }>(
              "SELECT external_id, status FROM outbox WHERE idempotency_key = ?",
              idempotencyKey
            );
            if (row?.status !== "completed" || row.external_id === null) {
              return;
            }
            const message = yield* database.first<MessageRow>(
              "SELECT conversation_id, external_id, id, outgoing, sender_id, sent_at, text, transport FROM messages WHERE external_id = ?",
              row.external_id
            );
            return message === null ? undefined : toMessage(message);
          }).pipe(
            Effect.mapError((cause) => repositoryError("outbox.find", cause))
          ),
        get: (conversationId) =>
          queryMessages(
            database,
            "SELECT conversation_id, external_id, id, outgoing, sender_id, sent_at, text, transport FROM messages WHERE conversation_id = ? ORDER BY sent_at",
            conversationId
          ),
        ingestEvent: (event: GoogleMessageEvent) =>
          Effect.gen(function* ingestEvent() {
            const inserted = yield* database.run(
              "INSERT OR IGNORE INTO protocol_events (external_id, event_type, received_at, payload_hash) VALUES (?, 'message', ?, ?)",
              event.id,
              new Date().toISOString(),
              event.message.externalId
            );
            if (inserted === 0) {
              return;
            }
            yield* database.batch([
              {
                parameters: [
                  event.message.conversationId,
                  event.message.conversationId,
                  event.message.sentAt.toISOString(),
                ],
                query:
                  "INSERT INTO conversations (id, title, last_message_at, unread_count) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET last_message_at = excluded.last_message_at",
              },
              {
                parameters: [event.message.senderId, event.message.senderId],
                query:
                  "INSERT OR IGNORE INTO participants (id, address) VALUES (?, ?)",
              },
              {
                parameters: [
                  event.message.conversationId,
                  event.message.senderId,
                ],
                query:
                  "INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_id) VALUES (?, ?)",
              },
              {
                parameters: [
                  event.message.id,
                  event.message.conversationId,
                  event.message.senderId,
                  event.message.externalId,
                  event.message.text,
                  event.message.transport,
                  event.message.sentAt.toISOString(),
                  event.message.outgoing ? 1 : 0,
                ],
                query:
                  "INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, external_id, text, transport, sent_at, outgoing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              },
              {
                parameters: [event.id, new Date().toISOString()],
                query:
                  "INSERT INTO sync_state (key, cursor, updated_at) VALUES ('google-messages-events', ?, ?) ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
              },
            ]);
          }).pipe(
            Effect.mapError((cause) => repositoryError("events.ingest", cause)),
            Effect.asVoid
          ),
        listConversations: database
          .all<ConversationRow>(
            "SELECT c.id, c.title, c.last_message_at, c.unread_count, GROUP_CONCAT(cp.participant_id) AS participant_ids FROM conversations c LEFT JOIN conversation_participants cp ON cp.conversation_id = c.id GROUP BY c.id ORDER BY c.last_message_at DESC"
          )
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                // SAFETY: rows are selected from the schema's conversation identifier column.
                id: row.id as Conversation["id"],
                lastMessageAt: new Date(row.last_message_at),
                participantIds: toParticipantIds(row.participant_ids),
                title: row.title,
                unreadCount: row.unread_count,
              }))
            ),
            Effect.mapError((cause) =>
              repositoryError("conversations.list", cause)
            )
          ),
        releaseIdempotencyKey: (idempotencyKey) =>
          database
            .run(
              "DELETE FROM outbox WHERE idempotency_key = ? AND status = 'pending'",
              idempotencyKey
            )
            .pipe(
              Effect.mapError((cause) =>
                repositoryError("outbox.release", cause)
              ),
              Effect.asVoid
            ),
        reserveIdempotencyKey: (
          idempotencyKey,
          conversationId = "",
          text = ""
        ) =>
          database
            .run(
              "INSERT INTO outbox (operation_id, idempotency_key, conversation_id, text, status, external_id, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?) ON CONFLICT(idempotency_key) DO UPDATE SET status = 'pending', conversation_id = excluded.conversation_id, text = excluded.text, updated_at = excluded.updated_at WHERE status IN ('pending', 'retryable') AND updated_at < ?",
              crypto.randomUUID(),
              idempotencyKey,
              conversationId,
              text,
              new Date().toISOString(),
              reservationCutoff()
            )
            .pipe(
              Effect.map((changes) => changes === 1),
              Effect.mapError((cause) =>
                repositoryError("outbox.reserve", cause)
              )
            ),
        search: (query) =>
          queryMessages(
            database,
            "SELECT conversation_id, external_id, id, outgoing, sender_id, sent_at, text, transport FROM messages WHERE text LIKE ? ORDER BY sent_at",
            `%${query}%`
          ),
        syncConversations: (conversations) =>
          database
            .batch(
              conversations.map((conversation) => ({
                parameters: [
                  conversation.id,
                  conversation.title,
                  conversation.lastMessageAt.toISOString(),
                  conversation.unreadCount,
                ],
                query:
                  "INSERT INTO conversations (id, title, last_message_at, unread_count) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, last_message_at = excluded.last_message_at, unread_count = excluded.unread_count",
              }))
            )
            .pipe(
              Effect.mapError((cause) =>
                repositoryError("conversations.sync", cause)
              ),
              Effect.asVoid
            ),
      };
      return service;
    })
  );
