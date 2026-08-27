import { Context, Effect, Layer } from "effect";

import type { Conversation, Message } from "../domain/message";
import { GoogleMessages } from "./google-messages";
import type { GoogleMessageEvent } from "./google-messages";
import { RepositoryError } from "./repository-error";

export interface DeliveryReservation {
  readonly owner: string;
}

/** Persistence failure. */
/** Queryable message persistence port. */
export interface MessageRepositoryService {
  readonly listConversations: Effect.Effect<
    readonly Conversation[],
    RepositoryError
  >;
  readonly syncConversations: (
    conversations: readonly Conversation[]
  ) => Effect.Effect<void, RepositoryError>;
  readonly ingestEvent: (
    event: GoogleMessageEvent
  ) => Effect.Effect<void, RepositoryError>;
  readonly get: (
    conversationId: string
  ) => Effect.Effect<readonly Message[], RepositoryError>;
  readonly search: (
    query: string
  ) => Effect.Effect<readonly Message[], RepositoryError>;
  readonly commitDelivery: (
    idempotencyKey: string,
    owner: string,
    message: Message
  ) => Effect.Effect<void, RepositoryError>;
  readonly failDelivery: (
    idempotencyKey: string,
    owner: string,
    reason: string,
    retryable: boolean
  ) => Effect.Effect<void, RepositoryError>;
  readonly findByIdempotencyKey: (
    idempotencyKey: string
  ) => Effect.Effect<Message | undefined, RepositoryError>;
  readonly reserveIdempotencyKey: (
    idempotencyKey: string,
    conversationId?: string,
    text?: string
  ) => Effect.Effect<DeliveryReservation | false, RepositoryError>;
  readonly releaseIdempotencyKey: (
    idempotencyKey: string,
    owner: string
  ) => Effect.Effect<void, RepositoryError>;
}

/** Message repository capability. */
export class MessageRepository extends Context.Service<
  MessageRepository,
  MessageRepositoryService
>()("gmessages/MessageRepository") {}

/** In-memory repository used by fake mode and tests. */
export const MessageRepositoryMemory = Layer.effect(
  MessageRepository,
  Effect.gen(function* MessageRepositoryMemory() {
    const provider = yield* Effect.service(GoogleMessages);
    const conversations = yield* provider.conversations;
    const initial = yield* provider.messages(conversations[0]?.id ?? "missing");
    const state = { messages: [...initial] };
    const reservations = new Map<
      string,
      { conversationId?: string; owner: string; text?: string }
    >();
    const completed = new Map<string, Message>();
    return {
      commitDelivery: (idempotencyKey, owner, message) =>
        Effect.gen(function* commitDelivery() {
          const reservation = reservations.get(idempotencyKey);
          if (
            reservation?.owner !== owner ||
            (reservation.conversationId !== undefined &&
              reservation.conversationId !== message.conversationId) ||
            (reservation.text !== undefined &&
              reservation.text !== message.text)
          ) {
            return yield* Effect.fail(
              new RepositoryError({
                cause: "delivery reservation is no longer owned",
                operation: "delivery.commit",
              })
            );
          }
          if (
            !state.messages.some(
              (existing) => existing.externalId === message.externalId
            )
          ) {
            state.messages.push(message);
          }
          reservations.delete(idempotencyKey);
          completed.set(idempotencyKey, message);
        }),
      failDelivery: (idempotencyKey, owner) =>
        Effect.sync(() => {
          if (reservations.get(idempotencyKey)?.owner === owner) {
            reservations.delete(idempotencyKey);
          }
        }),
      findByIdempotencyKey: (idempotencyKey) =>
        Effect.succeed(completed.get(idempotencyKey)),
      get: (conversationId) =>
        Effect.succeed(
          state.messages.filter(
            (message) => message.conversationId === conversationId
          )
        ),
      ingestEvent: () => Effect.void,
      listConversations: Effect.succeed(conversations),
      releaseIdempotencyKey: (idempotencyKey, owner) =>
        Effect.sync(() => {
          if (reservations.get(idempotencyKey)?.owner === owner) {
            reservations.delete(idempotencyKey);
          }
        }),
      reserveIdempotencyKey: (idempotencyKey, conversationId, text) =>
        Effect.gen(function* reserveIdempotencyKey() {
          const reservation = reservations.get(idempotencyKey);
          const existing = completed.get(idempotencyKey);
          if (
            (reservation &&
              (reservation.conversationId !== conversationId ||
                reservation.text !== text)) ||
            (existing &&
              (existing.conversationId !== conversationId ||
                existing.text !== text))
          ) {
            return yield* Effect.fail(
              new RepositoryError({
                cause: "idempotency key reused with different payload",
                operation: "outbox.payload",
              })
            );
          }
          if (reservation || existing) {
            return false;
          }
          const owner = crypto.randomUUID();
          reservations.set(idempotencyKey, { conversationId, owner, text });
          return { owner };
        }),
      search: (query) =>
        Effect.succeed(
          state.messages.filter((message) =>
            message.text.toLowerCase().includes(query.toLowerCase())
          )
        ),
      syncConversations: () => Effect.void,
    } satisfies MessageRepositoryService;
  })
);
