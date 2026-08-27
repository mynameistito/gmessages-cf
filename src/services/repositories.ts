import { Context, Effect, Layer } from "effect";

import type { Conversation, Message } from "../domain/message";
import { GoogleMessages } from "./google-messages";
import type { GoogleMessageEvent } from "./google-messages";
import type { RepositoryError } from "./repository-error";

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
    message: Message
  ) => Effect.Effect<void, RepositoryError>;
  readonly failDelivery: (
    idempotencyKey: string,
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
  ) => Effect.Effect<boolean, RepositoryError>;
  readonly releaseIdempotencyKey: (
    idempotencyKey: string
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
    const reservations = new Set<string>();
    const completed = new Map<string, Message>();
    return {
      commitDelivery: (idempotencyKey, message) =>
        Effect.sync(() => {
          if (
            !state.messages.some(
              (existing) => existing.externalId === message.externalId
            )
          ) {
            state.messages.push(message);
          }
          completed.set(idempotencyKey, message);
        }),
      failDelivery: () => Effect.void,
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
      releaseIdempotencyKey: (idempotencyKey) =>
        Effect.sync(() => {
          reservations.delete(idempotencyKey);
        }),
      reserveIdempotencyKey: (idempotencyKey) =>
        Effect.sync(() => {
          if (
            reservations.has(idempotencyKey) ||
            completed.has(idempotencyKey)
          ) {
            return false;
          }
          reservations.add(idempotencyKey);
          return true;
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
