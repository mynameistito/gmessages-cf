import { Context, Effect, Layer } from "effect";
import { z } from "zod";

import type { Conversation, Message } from "../domain/message";
import { GoogleMessages } from "./google-messages";
import type { GoogleMessageEvent } from "./google-messages";
import { RepositoryError } from "./repository-error";

export interface DeliveryReservation {
  readonly owner: string;
}

export interface MessagePageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export interface MessagePage {
  readonly messages: readonly Message[];
  readonly nextCursor?: string;
}

export const messageCursor = (message: Message) =>
  btoa(JSON.stringify([message.sentAt.toISOString(), message.id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const decodeMessageCursor = (
  cursor: string
): readonly [string, string] => {
  const value: unknown = JSON.parse(
    atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))
  );
  return z.tuple([z.string(), z.string()]).parse(value);
};

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
    conversationId: string,
    request: MessagePageRequest
  ) => Effect.Effect<MessagePage, RepositoryError>;
  readonly search: (
    query: string,
    request: MessagePageRequest
  ) => Effect.Effect<MessagePage, RepositoryError>;
  readonly persistMessages: (
    conversationId: string,
    messages: readonly Message[]
  ) => Effect.Effect<void, RepositoryError>;
  readonly isConversationHydrated: (
    conversationId: string
  ) => Effect.Effect<boolean, RepositoryError>;
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
      get: (conversationId, request) => {
        const messages = state.messages
          .filter((message) => message.conversationId === conversationId)
          .toSorted(
            (a, b) =>
              a.sentAt.getTime() - b.sentAt.getTime() ||
              a.id.localeCompare(b.id)
          );
        const start =
          request.cursor === undefined
            ? 0
            : messages.findIndex((message) => {
                const [sentAt, id] = decodeMessageCursor(request.cursor ?? "");
                return (
                  message.sentAt.toISOString() > sentAt ||
                  (message.sentAt.toISOString() === sentAt && message.id > id)
                );
              });
        const page = messages.slice(
          start < 0 ? messages.length : start,
          request.limit + 1
        );
        const result = { messages: page.slice(0, request.limit) };
        const last = page[request.limit - 1];
        return Effect.succeed(
          page.length > request.limit && last
            ? { ...result, nextCursor: messageCursor(last) }
            : result
        );
      },
      ingestEvent: () => Effect.void,
      isConversationHydrated: () => Effect.succeed(true),
      listConversations: Effect.succeed(conversations.slice(0, 100)),
      persistMessages: (_conversationId, messages) =>
        Effect.sync(() => {
          for (const message of messages) {
            if (
              !state.messages.some(
                (existing) => existing.externalId === message.externalId
              )
            ) {
              state.messages.push(message);
            }
          }
        }),
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
      search: (query, request) => {
        const messages = state.messages
          .filter((message) =>
            message.text.toLowerCase().includes(query.toLowerCase())
          )
          .toSorted(
            (a, b) =>
              a.sentAt.getTime() - b.sentAt.getTime() ||
              a.id.localeCompare(b.id)
          );
        const start =
          request.cursor === undefined
            ? 0
            : messages.findIndex((message) => {
                const [sentAt, id] = decodeMessageCursor(request.cursor ?? "");
                return (
                  message.sentAt.toISOString() > sentAt ||
                  (message.sentAt.toISOString() === sentAt && message.id > id)
                );
              });
        const page = messages.slice(
          start < 0 ? messages.length : start,
          request.limit + 1
        );
        const result = { messages: page.slice(0, request.limit) };
        const last = page[request.limit - 1];
        return Effect.succeed(
          page.length > request.limit && last
            ? { ...result, nextCursor: messageCursor(last) }
            : result
        );
      },
      syncConversations: () => Effect.void,
    } satisfies MessageRepositoryService;
  })
);
