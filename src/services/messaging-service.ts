import { Effect } from "effect";

import { GoogleMessages, GoogleMessagesError } from "./google-messages";
import { MessageRepository } from "./repositories";
import { RepositoryError } from "./repository-error";
import { SendInProgressError } from "./send-in-progress-error";

export const DEFAULT_READ_LIMIT = 50;
export const MAX_READ_LIMIT = 100;
export const validateReadRequest = (
  limit = DEFAULT_READ_LIMIT,
  cursor?: string
) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_READ_LIMIT}`);
  }
  if (cursor !== undefined && cursor.length === 0) {
    throw new Error("cursor must not be empty");
  }
  return { cursor, limit };
};

/** Indicates that another delivery currently owns the idempotency key. */
/** Application operations exposed by HTTP and MCP adapters. */
export const MessagingService = {
  getConversation: (
    conversationId: string,
    limit = DEFAULT_READ_LIMIT,
    cursor?: string
  ) =>
    Effect.gen(function* getConversation() {
      const repository = yield* Effect.service(MessageRepository);
      const request = validateReadRequest(limit, cursor);
      const page = yield* repository.get(conversationId, request);
      if (
        cursor === undefined &&
        page.messages.length === 0 &&
        !(yield* repository.isConversationHydrated(conversationId))
      ) {
        const provider = yield* Effect.service(GoogleMessages);
        yield* provider.connect;
        yield* repository.persistMessages(
          conversationId,
          yield* provider.messages(conversationId)
        );
        return yield* repository.get(conversationId, request);
      }
      return page;
    }),
  listConversations: Effect.gen(function* listConversations() {
    const provider = yield* Effect.service(GoogleMessages);
    const repository = yield* Effect.service(MessageRepository);
    yield* provider.connect;
    yield* repository.syncConversations(yield* provider.conversations);
    return yield* repository.listConversations;
  }),
  search: (query: string, limit = DEFAULT_READ_LIMIT, cursor?: string) =>
    Effect.gen(function* search() {
      const repository = yield* Effect.service(MessageRepository);
      return yield* repository.search(
        query,
        validateReadRequest(limit, cursor)
      );
    }),
  send: (conversationId: string, text: string, idempotencyKey: string) =>
    Effect.gen(function* send() {
      const provider = yield* Effect.service(GoogleMessages);
      const repository = yield* Effect.service(MessageRepository);
      const existing = yield* repository.findByIdempotencyKey(idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.conversationId !== conversationId ||
          existing.text !== text
        ) {
          return yield* Effect.fail(
            new RepositoryError({
              cause: "idempotency key reused with different payload",
              operation: "outbox.payload",
            })
          );
        }
        return existing;
      }
      const reservation = yield* repository.reserveIdempotencyKey(
        idempotencyKey,
        conversationId,
        text
      );
      if (!reservation) {
        return yield* Effect.fail(new SendInProgressError({ idempotencyKey }));
      }
      yield* provider.connect.pipe(
        Effect.tapError(() =>
          repository.releaseIdempotencyKey(idempotencyKey, reservation.owner)
        )
      );
      const message = yield* provider
        .send(conversationId, text, idempotencyKey)
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((error) =>
            "retryable" in error
              ? error
              : new GoogleMessagesError({
                  reason: "provider timeout",
                  retryable: true,
                })
          ),
          Effect.tapError((error) =>
            repository.failDelivery(
              idempotencyKey,
              reservation.owner,
              error.reason,
              error.retryable
            )
          )
        );
      yield* repository.commitDelivery(
        idempotencyKey,
        reservation.owner,
        message
      );
      return message;
    }),
};
