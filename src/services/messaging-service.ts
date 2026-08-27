import { Effect } from "effect";

import { GoogleMessages, GoogleMessagesError } from "./google-messages";
import { MessageRepository } from "./repositories";
import { RepositoryError } from "./repository-error";
import { SendInProgressError } from "./send-in-progress-error";

/** Indicates that another delivery currently owns the idempotency key. */
/** Application operations exposed by HTTP and MCP adapters. */
export const MessagingService = {
  getConversation: (conversationId: string) =>
    Effect.gen(function* getConversation() {
      const repository = yield* Effect.service(MessageRepository);
      return yield* repository.get(conversationId);
    }),
  listConversations: Effect.gen(function* listConversations() {
    const provider = yield* Effect.service(GoogleMessages);
    const repository = yield* Effect.service(MessageRepository);
    yield* provider.connect;
    yield* repository.syncConversations(yield* provider.conversations);
    return yield* repository.listConversations;
  }),
  search: (query: string) =>
    Effect.gen(function* search() {
      const repository = yield* Effect.service(MessageRepository);
      return yield* repository.search(query);
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
